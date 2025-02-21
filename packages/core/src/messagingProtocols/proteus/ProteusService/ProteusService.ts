/*
 * Wire
 * Copyright (C) 2022 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import type {APIClient} from '@wireapp/api-client/lib/APIClient';
import type {PreKey, Context} from '@wireapp/api-client/lib/auth';
import type {
  Conversation,
  NewConversation,
  OTRRecipients,
  QualifiedOTRRecipients,
  QualifiedUserClients,
  UserClients,
} from '@wireapp/api-client/lib/conversation';
import type {QualifiedId, QualifiedUserPreKeyBundleMap, UserPreKeyBundleMap} from '@wireapp/api-client/lib/user';
import logdown from 'logdown';

import {ClientAction} from '@wireapp/protocol-messaging';
import {CRUDEngine} from '@wireapp/store-engine';

import {CryptoClient} from './CryptoClient';
import {cryptoMigrationStore} from './cryptoMigrationStateStore';
import {generateDecryptionError} from './DecryptionErrorGenerator';
import type {
  AddUsersToProteusConversationParams,
  CreateProteusConversationParams,
  ProteusServiceConfig,
  SendProteusMessageParams,
} from './ProteusService.types';
import {migrateToQualifiedSessionIds} from './sessionIdMigrator';

import {GenericMessageType, MessageSendingState, SendResult} from '../../../conversation';
import {MessageService} from '../../../conversation/message/MessageService';
import type {EventHandlerResult} from '../../common.types';
import {EventHandlerParams, handleBackendEvent} from '../EventHandler';
import {getGenericMessageParams} from '../Utility/getGenericMessageParams';
import {isClearFromMismatch} from '../Utility/isClearFromMismatch';
import {
  buildEncryptedPayloads,
  constructSessionId,
  deleteSession,
  initSession,
  initSessions,
} from '../Utility/SessionHandler';

export class ProteusService {
  private readonly messageService: MessageService;
  private readonly logger = logdown('@wireapp/core/ProteusService');

  constructor(
    private readonly apiClient: APIClient,
    private readonly cryptoClient: CryptoClient,
    private readonly config: ProteusServiceConfig,
  ) {
    this.messageService = new MessageService(this.apiClient, this);
  }

  public async handleEvent(params: Pick<EventHandlerParams, 'event' | 'source' | 'dryRun'>): EventHandlerResult {
    const handledEvent = await handleBackendEvent({
      ...params,
      decryptMessage: (payload, userId, clientId) => this.decrypt(payload, userId, clientId),
    });
    if (handledEvent?.decryptedData) {
      const isSessionReset =
        handledEvent.decryptedData[GenericMessageType.CLIENT_ACTION] === ClientAction.RESET_SESSION;
      if (isSessionReset) {
        this.logger.debug('A session was reset from a remote device');
        // If a session reset message was received, we need to count a consumed prekey (because the sender has created a new session from a new prekey)
        await this.cryptoClient.consumePrekey();
      }
    }
    return handledEvent;
  }

  public async initClient(storeEngine: CRUDEngine, context: Context) {
    const dbName = storeEngine.storeName;
    if (context.domain && this.config.useQualifiedIds) {
      // We want sessions to be fully qualified from now on

      if (!cryptoMigrationStore.qualifiedSessions.isReady(dbName)) {
        this.logger.info(`Migrating existing session ids to qualified ids.`);
        await migrateToQualifiedSessionIds(storeEngine, context.domain);
        cryptoMigrationStore.qualifiedSessions.markAsReady(dbName);
        this.logger.info(`Successfully migrated session ids to qualified ids.`);
      }
    }

    if (!cryptoMigrationStore.coreCrypto.isReady(dbName) && this.cryptoClient.migrateFromCryptobox) {
      this.logger.info(`Migrating data from cryptobox store (${dbName}) to corecrypto.`);
      try {
        await this.cryptoClient.migrateFromCryptobox(dbName);
        cryptoMigrationStore.coreCrypto.markAsReady(dbName);
        this.logger.info(`Successfully migrated from cryptobox store (${dbName}) to corecrypto.`);
      } catch (error) {
        this.logger.error('Client was not able to perform DB migration: ', error);
      }
    }
    return this.cryptoClient.init();
  }

  public createClient(entropy?: Uint8Array) {
    return this.cryptoClient.create(this.config.nbPrekeys, entropy);
  }

  /**
   * Get the fingerprint of the local client.
   */
  public getLocalFingerprint() {
    return this.cryptoClient.getFingerprint();
  }

  public constructSessionId(userId: string | QualifiedId, clientId: string, domain?: string): string {
    return constructSessionId({clientId, userId, domain, useQualifiedIds: this.config.useQualifiedIds});
  }

  /**
   * Get the fingerprint of a remote client
   * @param userId ID of user
   * @param clientId ID of client
   * @param prekey A prekey can be given to create a session if it doesn't already exist.
   *   If not provided and the session doesn't exists it will fetch a new prekey from the backend
   */
  public async getRemoteFingerprint(userId: QualifiedId, clientId: string, prekey?: PreKey) {
    const sessionId = await initSession(
      {userId, clientId, initialPrekey: prekey},
      {cryptoClient: this.cryptoClient, apiClient: this.apiClient},
    );
    return this.cryptoClient.getRemoteFingerprint(sessionId);
  }

  public async createConversation({
    conversationData,
    otherUserIds,
  }: CreateProteusConversationParams): Promise<Conversation> {
    let payload: NewConversation;
    if (typeof conversationData === 'string') {
      const ids = typeof otherUserIds === 'string' ? [otherUserIds] : otherUserIds;

      payload = {
        name: conversationData,
        receipt_mode: null,
        users: ids ?? [],
      };
    } else {
      payload = conversationData;
    }

    return this.apiClient.api.conversation.postConversation(payload);
  }

  public async addUsersToConversation({conversationId, qualifiedUserIds}: AddUsersToProteusConversationParams) {
    return this.apiClient.api.conversation.postMembers(conversationId, qualifiedUserIds);
  }

  public async sendMessage({
    userIds,
    sendAsProtobuf,
    conversationId,
    nativePush,
    targetMode,
    payload,
    onClientMismatch,
  }: SendProteusMessageParams): Promise<SendResult> {
    const messageParams = await getGenericMessageParams({
      apiClient: this.apiClient,
      sendingClientId: this.apiClient.validatedClientId,
      conversationId,
      genericMessage: payload,
      useQualifiedIds: this.config.useQualifiedIds,
      options: {
        userIds,
        sendAsProtobuf,
        nativePush,
        targetMode,
        onClientMismatch,
      },
    });

    const {federated, sendingClientId, recipients, plainText, options} = messageParams;
    const response = federated
      ? await this.messageService.sendFederatedMessage(sendingClientId, recipients, plainText, {
          ...options,
          onClientMismatch: mismatch => onClientMismatch?.(mismatch, false),
        })
      : await this.messageService.sendMessage(sendingClientId, recipients, plainText, {
          ...options,
          sendAsProtobuf,
          onClientMismatch: mismatch => onClientMismatch?.(mismatch, false),
        });

    if (!response.errored) {
      if (!isClearFromMismatch(response)) {
        // We warn the consumer that there is a mismatch that did not prevent message sending
        await onClientMismatch?.(response, true);
      }
      this.logger.log(`Successfully sent Proteus message to conversation '${conversationId.id}'`);
    }

    return {
      id: payload.messageId,
      sentAt: response.time,
      state: response.errored ? MessageSendingState.CANCELLED : MessageSendingState.OUTGOING_SENT,
    };
  }

  private async decrypt(encryptedText: Uint8Array, userId: QualifiedId, clientId: string) {
    const sessionId = this.constructSessionId(userId, clientId);
    const sessionExists = await this.cryptoClient.sessionExists(sessionId);

    try {
      const decryptedMessage: Uint8Array = !sessionExists
        ? await this.cryptoClient.sessionFromMessage(sessionId, encryptedText)
        : await this.cryptoClient.decrypt(sessionId, encryptedText);

      if (!sessionExists) {
        await this.cryptoClient.saveSession(sessionId);
        this.config.onNewClient?.({userId, clientId});
        this.logger.info(`Created a new session from message for session ID "${sessionId}" and decrypted the message`);
      } else {
        this.logger.info(`Decrypted message for session ID "${sessionId}"`);
      }

      return decryptedMessage;
    } catch (error) {
      throw generateDecryptionError({userId, clientId}, error);
    }
  }

  public async encrypt(
    plainText: Uint8Array,
    recipients: UserPreKeyBundleMap | UserClients,
    domain: string = '',
  ): Promise<OTRRecipients<Uint8Array>> {
    const sessions = await initSessions({
      recipients,
      domain,
      apiClient: this.apiClient,
      cryptoClient: this.cryptoClient,
      logger: this.logger,
    });

    const payload = await this.cryptoClient.encrypt(sessions, plainText);

    return buildEncryptedPayloads(payload);
  }

  public deleteSession(userId: QualifiedId, clientId: string) {
    return deleteSession({
      userId,
      clientId,
      useQualifiedIds: this.config.useQualifiedIds,
      cryptoClient: this.cryptoClient,
    });
  }

  public async encryptQualified(
    plainText: Uint8Array,
    preKeyBundles: QualifiedUserPreKeyBundleMap | QualifiedUserClients,
  ): Promise<QualifiedOTRRecipients> {
    const qualifiedOTRRecipients: QualifiedOTRRecipients = {};

    for (const [domain, preKeyBundleMap] of Object.entries(preKeyBundles)) {
      const result = await this.encrypt(plainText, preKeyBundleMap, domain);
      qualifiedOTRRecipients[domain] = result;
    }

    return qualifiedOTRRecipients;
  }

  wipe() {
    return this.cryptoClient.wipe();
  }
}
