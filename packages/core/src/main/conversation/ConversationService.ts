/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
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

import type {APIClient} from '@wireapp/api-client';
import {
  MessageSendingStatus,
  Conversation,
  CONVERSATION_TYPE,
  DefaultConversationRoleName,
  MutedStatus,
  NewConversation,
  QualifiedUserClients,
  UserClients,
  ClientMismatch,
} from '@wireapp/api-client/src/conversation/';
import {CONVERSATION_TYPING, ConversationMemberUpdateData} from '@wireapp/api-client/src/conversation/data/';
import type {ConversationMemberLeaveEvent} from '@wireapp/api-client/src/event/';
import type {QualifiedId, QualifiedUserPreKeyBundleMap, UserPreKeyBundleMap} from '@wireapp/api-client/src/user/';
import {
  Asset,
  ButtonAction,
  ButtonActionConfirmation,
  Calling,
  Cleared,
  ClientAction,
  Composite,
  Confirmation,
  Ephemeral,
  GenericMessage,
  Knock,
  Location,
  MessageDelete,
  MessageEdit,
  MessageHide,
  Reaction,
} from '@wireapp/protocol-messaging';
import {Encoder} from 'bazinga64';

import {
  AssetService,
  AssetTransferState,
  GenericMessageType,
  MessageTimer,
  PayloadBundleSource,
  PayloadBundleState,
  PayloadBundleType,
} from '../conversation/';
import type {AssetContent, ClearedContent, DeletedContent, HiddenContent, RemoteData} from '../conversation/content/';
import type {CryptographyService, EncryptedAsset} from '../cryptography/';
import * as AssetCryptography from '../cryptography/AssetCryptography.node';
import {isStringArray, isQualifiedIdArray, isQualifiedUserClients, isUserClients} from '../util/TypePredicateUtil';
import {MessageBuilder} from './message/MessageBuilder';
import {MessageService} from './message/MessageService';
import {MessageToProtoMapper} from './message/MessageToProtoMapper';
import type {
  ButtonActionConfirmationMessage,
  ButtonActionMessage,
  CallMessage,
  ClearConversationMessage,
  CompositeMessage,
  ConfirmationMessage,
  DeleteMessage,
  EditedTextMessage,
  FileAssetAbortMessage,
  FileAssetMessage,
  FileAssetMetaDataMessage,
  HideMessage,
  ImageAssetMessageOutgoing,
  LocationMessage,
  OtrMessage,
  PingMessage,
  ReactionMessage,
  ResetSessionMessage,
  TextMessage,
} from './message/OtrMessage';

export interface MessageSendingCallbacks {
  onStart?: (message: GenericMessage) => void;
  onSuccess?: (message: GenericMessage, sentTime?: string) => void;
  onClientMismatch?: (status: ClientMismatch | MessageSendingStatus) => Promise<boolean | undefined>;
}

export class ConversationService {
  public readonly messageTimer: MessageTimer;
  public readonly messageBuilder: MessageBuilder;
  private readonly messageService: MessageService;

  constructor(
    private readonly apiClient: APIClient,
    private readonly cryptographyService: CryptographyService,
    private readonly assetService: AssetService,
  ) {
    this.messageTimer = new MessageTimer();
    this.messageBuilder = new MessageBuilder(this.apiClient, this.assetService);
    this.messageService = new MessageService(this.apiClient, this.cryptographyService);
  }

  private createEphemeral(originalGenericMessage: GenericMessage, expireAfterMillis: number): GenericMessage {
    const ephemeralMessage = Ephemeral.create({
      expireAfterMillis,
      [originalGenericMessage.content!]: originalGenericMessage[originalGenericMessage.content!],
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.EPHEMERAL]: ephemeralMessage,
      messageId: originalGenericMessage.messageId,
    });

    return genericMessage;
  }

  private async getConversationQualifiedMembers(conversationId: QualifiedId): Promise<QualifiedId[]> {
    const conversation = await this.apiClient.conversation.api.getConversation(conversationId, true);
    /*
     * If you are sending a message to a conversation, you have to include
     * yourself in the list of users if you want to sync a message also to your
     * other clients.
     */
    return (
      conversation.members.others
        .filter(member => !!member.qualified_id)
        .map(member => member.qualified_id!)
        // TODO(Federation): Use 'domain' from 'conversation.members.self' when backend has it implemented
        .concat({domain: this.apiClient.context!.domain!, id: conversation.members.self.id})
    );
  }

  /**
   * Will generate a prekey bundle for specific users.
   * If a QualifiedId array is given the bundle will contain all the clients from those users fetched from the server.
   * If a QualifiedUserClients is provided then only the clients in the payload will be targeted (which could generate a ClientMismatch when sending messages)
   *
   * @param {QualifiedId[]|QualifiedUserClients} userIds - Targeted users.
   * @returns {Promise<QualifiedUserPreKeyBundleMap}
   */
  private async getQualifiedPreKeyBundle(
    userIds: QualifiedId[] | QualifiedUserClients,
  ): Promise<QualifiedUserPreKeyBundleMap> {
    type Target = {id: QualifiedId; clients?: string[]};
    let targets: Target[] = [];

    if (userIds) {
      if (isQualifiedIdArray(userIds)) {
        targets = userIds.map(id => ({id}));
      } else {
        targets = Object.entries(userIds).reduce<Target[]>((accumulator, [domain, userClients]) => {
          for (const userId in userClients) {
            accumulator.push({id: {id: userId, domain}, clients: userClients[userId]});
          }
          return accumulator;
        }, []);
      }
    }

    const preKeys = await Promise.all(
      targets.map(async ({id: userId, clients}) => {
        const prekeyBundle = await this.apiClient.user.api.getUserPreKeys(userId);
        // We filter the clients that should not receive the message (if a QualifiedUserClients was given as parameter)
        const userClients = clients
          ? prekeyBundle.clients.filter(client => clients.includes(client.client))
          : prekeyBundle.clients;
        return {user: userId, clients: userClients};
      }),
    );

    return preKeys.reduce<QualifiedUserPreKeyBundleMap>((bundleMap, qualifiedPrekey) => {
      bundleMap[qualifiedPrekey.user.domain] ||= {};
      for (const client of qualifiedPrekey.clients) {
        bundleMap[qualifiedPrekey.user.domain][qualifiedPrekey.user.id] ||= {};
        bundleMap[qualifiedPrekey.user.domain][qualifiedPrekey.user.id][client.client] = client.prekey;
      }
      return bundleMap;
    }, {});
  }

  async getPreKeyBundleMap(conversationId: string, userIds?: string[] | UserClients): Promise<UserPreKeyBundleMap> {
    let members: string[] = [];

    if (userIds) {
      if (isStringArray(userIds)) {
        members = userIds;
      } else if (isUserClients(userIds)) {
        members = Object.keys(userIds);
      }
    }

    if (!members.length) {
      const conversation = await this.apiClient.conversation.api.getConversation(conversationId);
      /*
       * If you are sending a message to a conversation, you have to include
       * yourself in the list of users if you want to sync a message also to your
       * other clients.
       */
      members = conversation.members.others.map(member => member.id).concat(conversation.members.self.id);
    }

    const preKeys = await Promise.all(members.map(member => this.apiClient.user.api.getUserPreKeys(member)));

    return preKeys.reduce((bundleMap: UserPreKeyBundleMap, bundle) => {
      const userId = bundle.user;
      bundleMap[userId] ||= {};
      for (const client of bundle.clients) {
        bundleMap[userId][client.client] = client.prekey;
      }
      return bundleMap;
    }, {});
  }

  private getSelfConversation(): Promise<Conversation> {
    const {userId} = this.apiClient.context!;
    return this.apiClient.conversation.api.getConversation(userId);
  }

  private async sendExternalGenericMessage(
    sendingClientId: string,
    conversationId: string,
    asset: EncryptedAsset,
    preKeyBundles: UserPreKeyBundleMap,
    sendAsProtobuf?: boolean,
  ): Promise<ClientMismatch | undefined> {
    if (preKeyBundles.none) {
      const {cipherText, keyBytes, sha256} = asset;
      const messageId = MessageBuilder.createId();

      const externalMessage = {
        otrKey: new Uint8Array(keyBytes),
        sha256: new Uint8Array(sha256),
      };

      const base64CipherText = Encoder.toBase64(cipherText).asString;

      const genericMessage = GenericMessage.create({
        [GenericMessageType.EXTERNAL]: externalMessage,
        messageId,
      });

      const plainTextArray = GenericMessage.encode(genericMessage).finish();

      const recipients = await this.cryptographyService.encrypt(plainTextArray, preKeyBundles);

      if (sendAsProtobuf) {
        return this.messageService.sendOTRProtobufMessage(
          sendingClientId,
          recipients,
          conversationId,
          plainTextArray,
          cipherText,
        );
      }
      return this.messageService.sendOTRMessage(
        sendingClientId,
        recipients,
        conversationId,
        plainTextArray,
        base64CipherText,
      );

      // todo: add federated sending here
    }
    return undefined;
  }

  private async getQualifiedRecipientsForConversation(
    conversationId: QualifiedId,
    userIds?: QualifiedId[] | QualifiedUserClients,
  ): Promise<QualifiedUserClients | QualifiedUserPreKeyBundleMap> {
    if (isQualifiedUserClients(userIds)) {
      return userIds;
    }
    const recipientIds = userIds || (await this.getConversationQualifiedMembers(conversationId));
    return this.getQualifiedPreKeyBundle(recipientIds);
  }

  /**
   * Sends a message to a federated environment.
   *
   * @param sendingClientId The clientId from which the message is sent
   * @param conversationId The conversation in which to send the message
   * @param conversationDomain The domain where the conversation lives
   * @param genericMessage The payload of the message to send
   * @param options.userIds? can be either a QualifiedId[] or QualfiedUserClients or undefined. The type has some effect on the behavior of the method.
   *    When given undefined the method will fetch both the members of the conversations and their devices. No ClientMismatch can happen in that case
   *    When given a QualifiedId[] the method will fetch the freshest list of devices for those users (since they are not given by the consumer). As a consequence no ClientMismatch error will trigger and we will ignore missing clients when sending
   *    When given a QualifiedUserClients the method will only send to the clients listed in the userIds. This could lead to ClientMismatch (since the given list of devices might not be the freshest one and new clients could have been created)
   * @param options.onClientMismatch? Will be called whenever there is a clientmismatch returned from the server. Needs to be combined with a userIds of type QualifiedUserClients
   * @return Resolves with the message sending status from backend
   */
  private async sendFederatedGenericMessage(
    sendingClientId: string,
    conversationId: QualifiedId,
    genericMessage: GenericMessage,
    options: {
      userIds?: QualifiedId[] | QualifiedUserClients;
      onClientMismatch?: (mismatch: MessageSendingStatus) => Promise<boolean | undefined>;
    } = {},
  ): Promise<MessageSendingStatus> {
    const plainTextArray = GenericMessage.encode(genericMessage).finish();
    const recipients = await this.getQualifiedRecipientsForConversation(conversationId, options.userIds);

    return this.messageService.sendFederatedOTRMessage(sendingClientId, conversationId, recipients, plainTextArray, {
      reportMissing: isQualifiedUserClients(options.userIds), // we want to check mismatch in case the consumer gave an exact list of users/devices
      onClientMismatch: options.onClientMismatch,
    });
  }

  private async sendGenericMessage(
    sendingClientId: string,
    conversationId: string,
    genericMessage: GenericMessage,
    options: {
      domain?: string;
      userIds?: string[] | QualifiedId[] | UserClients | QualifiedUserClients;
      sendAsProtobuf?: boolean;
      onClientMismatch?: (mistmatch: ClientMismatch | MessageSendingStatus) => Promise<boolean | undefined>;
    } = {},
  ): Promise<ClientMismatch | MessageSendingStatus | undefined> {
    const {domain, userIds} = options;
    if (domain) {
      if (isStringArray(userIds) || isUserClients(userIds)) {
        throw new Error('Invalid userIds option for sending');
      }

      return this.sendFederatedGenericMessage(
        this.apiClient.validatedClientId,
        {id: conversationId, domain},
        genericMessage,
        {userIds, onClientMismatch: options.onClientMismatch},
      );
    }

    if (isQualifiedIdArray(userIds) || isQualifiedUserClients(userIds)) {
      throw new Error('Invalid userIds option for sending');
    }

    const plainTextArray = GenericMessage.encode(genericMessage).finish();
    const preKeyBundles = await this.getPreKeyBundleMap(conversationId, userIds);

    if (this.shouldSendAsExternal(plainTextArray, preKeyBundles)) {
      const encryptedAsset = await AssetCryptography.encryptAsset({plainText: plainTextArray});
      return this.sendExternalGenericMessage(
        this.apiClient.validatedClientId,
        conversationId,
        encryptedAsset,
        preKeyBundles,
        options.sendAsProtobuf,
      );
    }

    const recipients = await this.cryptographyService.encrypt(plainTextArray, preKeyBundles);

    return options.sendAsProtobuf
      ? this.messageService.sendOTRProtobufMessage(sendingClientId, recipients, conversationId, plainTextArray)
      : this.messageService.sendOTRMessage(sendingClientId, recipients, conversationId, plainTextArray);
  }

  private generateButtonActionGenericMessage(payloadBundle: ButtonActionMessage): GenericMessage {
    return GenericMessage.create({
      [GenericMessageType.BUTTON_ACTION]: ButtonAction.create(payloadBundle.content),
      messageId: payloadBundle.id,
    });
  }

  private generateButtonActionConfirmationGenericMessage(
    payloadBundle: ButtonActionConfirmationMessage,
  ): GenericMessage {
    return GenericMessage.create({
      [GenericMessageType.BUTTON_ACTION_CONFIRMATION]: ButtonActionConfirmation.create(payloadBundle.content),
      messageId: payloadBundle.id,
    });
  }

  private generateCompositeGenericMessage(payloadBundle: CompositeMessage): GenericMessage {
    return GenericMessage.create({
      [GenericMessageType.COMPOSITE]: Composite.create(payloadBundle.content),
      messageId: payloadBundle.id,
    });
  }

  private generateConfirmationGenericMessage(payloadBundle: ConfirmationMessage): GenericMessage {
    const content = Confirmation.create(payloadBundle.content);

    return GenericMessage.create({
      [GenericMessageType.CONFIRMATION]: content,
      messageId: payloadBundle.id,
    });
  }

  private generateEditedTextGenericMessage(payloadBundle: EditedTextMessage): GenericMessage {
    const editedMessage = MessageEdit.create({
      replacingMessageId: payloadBundle.content.originalMessageId,
      text: MessageToProtoMapper.mapText(payloadBundle),
    });

    return GenericMessage.create({
      [GenericMessageType.EDITED]: editedMessage,
      messageId: payloadBundle.id,
    });
  }

  private generateFileDataGenericMessage(payloadBundle: FileAssetMessage): GenericMessage {
    if (!payloadBundle.content) {
      throw new Error('No content for sendFileData provided.');
    }

    const {asset, expectsReadConfirmation, legalHoldStatus} = payloadBundle.content;

    const remoteData = Asset.RemoteData.create({
      assetId: asset.key,
      assetToken: asset.token,
      otrKey: asset.keyBytes,
      sha256: asset.sha256,
    });

    const assetMessage = Asset.create({
      expectsReadConfirmation,
      legalHoldStatus,
      uploaded: remoteData,
    });

    assetMessage.status = AssetTransferState.UPLOADED;

    const genericMessage = GenericMessage.create({
      [GenericMessageType.ASSET]: assetMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    return expireAfterMillis > 0 ? this.createEphemeral(genericMessage, expireAfterMillis) : genericMessage;
  }

  private generateFileMetaDataGenericMessage(payloadBundle: FileAssetMetaDataMessage): GenericMessage {
    if (!payloadBundle.content) {
      throw new Error('No content for sendFileMetaData provided.');
    }

    const {expectsReadConfirmation, legalHoldStatus, metaData} = payloadBundle.content;

    const original = Asset.Original.create({
      audio: metaData.audio,
      mimeType: metaData.type,
      name: metaData.name,
      size: metaData.length,
      video: metaData.video,
    });

    const assetMessage = Asset.create({
      expectsReadConfirmation,
      legalHoldStatus,
      original,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.ASSET]: assetMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    return expireAfterMillis > 0 ? this.createEphemeral(genericMessage, expireAfterMillis) : genericMessage;
  }

  private generateFileAbortGenericMessage(payloadBundle: FileAssetAbortMessage): GenericMessage {
    if (!payloadBundle.content) {
      throw new Error('No content for sendFileAbort provided.');
    }

    const {expectsReadConfirmation, legalHoldStatus, reason} = payloadBundle.content;

    const assetMessage = Asset.create({
      expectsReadConfirmation,
      legalHoldStatus,
      notUploaded: reason,
    });

    assetMessage.status = AssetTransferState.NOT_UPLOADED;

    const genericMessage = GenericMessage.create({
      [GenericMessageType.ASSET]: assetMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    return expireAfterMillis > 0 ? this.createEphemeral(genericMessage, expireAfterMillis) : genericMessage;
  }

  private generateImageGenericMessage(payloadBundle: ImageAssetMessageOutgoing): {
    content: AssetContent;
    genericMessage: GenericMessage;
  } {
    if (!payloadBundle.content) {
      throw new Error('No content for sendImage provided.');
    }

    const {asset, expectsReadConfirmation, image, legalHoldStatus} = payloadBundle.content;

    const imageMetadata = Asset.ImageMetaData.create({
      height: image.height,
      width: image.width,
    });

    const original = Asset.Original.create({
      [GenericMessageType.IMAGE]: imageMetadata,
      mimeType: image.type,
      name: null,
      size: image.data.length,
    });

    const remoteData = Asset.RemoteData.create({
      assetId: asset.key,
      assetToken: asset.token,
      otrKey: asset.keyBytes,
      sha256: asset.sha256,
    });

    const assetMessage = Asset.create({
      expectsReadConfirmation,
      legalHoldStatus,
      original,
      uploaded: remoteData,
    });

    assetMessage.status = AssetTransferState.UPLOADED;

    let genericMessage = GenericMessage.create({
      [GenericMessageType.ASSET]: assetMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    if (expireAfterMillis) {
      genericMessage = this.createEphemeral(genericMessage, expireAfterMillis);
    }
    return {content: assetMessage as AssetContent, genericMessage};
  }

  private generateLocationGenericMessage(payloadBundle: LocationMessage): GenericMessage {
    const {expectsReadConfirmation, latitude, legalHoldStatus, longitude, name, zoom} = payloadBundle.content;

    const locationMessage = Location.create({
      expectsReadConfirmation,
      latitude,
      legalHoldStatus,
      longitude,
      name,
      zoom,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.LOCATION]: locationMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    return expireAfterMillis > 0 ? this.createEphemeral(genericMessage, expireAfterMillis) : genericMessage;
  }

  private generatePingGenericMessage(payloadBundle: PingMessage): GenericMessage {
    const content = Knock.create(payloadBundle.content);

    const genericMessage = GenericMessage.create({
      [GenericMessageType.KNOCK]: content,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    return expireAfterMillis > 0 ? this.createEphemeral(genericMessage, expireAfterMillis) : genericMessage;
  }

  private generateReactionGenericMessage(payloadBundle: ReactionMessage): GenericMessage {
    const {legalHoldStatus, originalMessageId, type} = payloadBundle.content;

    const reaction = Reaction.create({
      emoji: type,
      legalHoldStatus,
      messageId: originalMessageId,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.REACTION]: reaction,
      messageId: payloadBundle.id,
    });
    return genericMessage;
  }

  private generateSessionResetGenericMessage(payloadBundle: ResetSessionMessage): GenericMessage {
    return GenericMessage.create({
      [GenericMessageType.CLIENT_ACTION]: ClientAction.RESET_SESSION,
      messageId: payloadBundle.id,
    });
  }

  private generateCallGenericMessage(payloadBundle: CallMessage): GenericMessage {
    const callMessage = Calling.create({
      content: payloadBundle.content,
    });

    return GenericMessage.create({
      [GenericMessageType.CALLING]: callMessage,
      messageId: payloadBundle.id,
    });
  }

  private generateTextGenericMessage(payloadBundle: TextMessage): GenericMessage {
    const genericMessage = GenericMessage.create({
      messageId: payloadBundle.id,
      [GenericMessageType.TEXT]: MessageToProtoMapper.mapText(payloadBundle),
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    return expireAfterMillis > 0 ? this.createEphemeral(genericMessage, expireAfterMillis) : genericMessage;
  }

  public async clearConversation(
    conversationId: string,
    timestamp: number | Date = new Date(),
    messageId: string = MessageBuilder.createId(),
    sendAsProtobuf?: boolean,
    conversationDomain?: string,
  ): Promise<ClearConversationMessage> {
    if (timestamp instanceof Date) {
      timestamp = timestamp.getTime();
    }

    const content: ClearedContent = {
      clearedTimestamp: timestamp,
      conversationId,
    };

    const clearedMessage = Cleared.create(content);

    const genericMessage = GenericMessage.create({
      [GenericMessageType.CLEARED]: clearedMessage,
      messageId,
    });

    const {id: selfConversationId} = await this.getSelfConversation();

    await this.sendGenericMessage(this.apiClient.validatedClientId, selfConversationId, genericMessage, {
      domain: conversationDomain,
      sendAsProtobuf,
    });

    return {
      content,
      conversation: conversationId,
      from: this.apiClient.context!.userId,
      id: messageId,
      messageTimer: 0,
      source: PayloadBundleSource.LOCAL,
      state: PayloadBundleState.OUTGOING_SENT,
      timestamp: Date.now(),
      type: PayloadBundleType.CONVERSATION_CLEAR,
    };
  }

  public async deleteMessageLocal(
    conversationId: string,
    messageIdToHide: string,
    sendAsProtobuf?: boolean,
    conversationDomain?: string,
  ): Promise<HideMessage> {
    const messageId = MessageBuilder.createId();

    const content: HiddenContent = MessageHide.create({
      conversationId,
      messageId: messageIdToHide,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.HIDDEN]: content,
      messageId,
    });

    const {id: selfConversationId} = await this.getSelfConversation();

    await this.sendGenericMessage(this.apiClient.validatedClientId, selfConversationId, genericMessage, {
      sendAsProtobuf,
      domain: conversationDomain,
    });

    return {
      content,
      conversation: conversationId,
      from: this.apiClient.context!.userId,
      id: messageId,
      messageTimer: this.messageTimer.getMessageTimer(conversationId),
      source: PayloadBundleSource.LOCAL,
      state: PayloadBundleState.OUTGOING_SENT,
      timestamp: Date.now(),
      type: PayloadBundleType.MESSAGE_HIDE,
    };
  }

  public async deleteMessageEveryone(
    conversationId: string,
    messageIdToDelete: string,
    userIds?: string[] | QualifiedId[] | UserClients | QualifiedUserClients,
    sendAsProtobuf?: boolean,
    conversationDomain?: string,
    callbacks?: MessageSendingCallbacks,
  ): Promise<DeleteMessage> {
    const messageId = MessageBuilder.createId();

    const content: DeletedContent = MessageDelete.create({
      messageId: messageIdToDelete,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.DELETED]: content,
      messageId,
    });
    callbacks?.onStart?.(genericMessage);

    const response = await this.sendGenericMessage(this.apiClient.validatedClientId, conversationId, genericMessage, {
      userIds,
      sendAsProtobuf,
      domain: conversationDomain,
    });
    callbacks?.onSuccess?.(genericMessage, response?.time);

    return {
      content,
      conversation: conversationId,
      from: this.apiClient.context!.userId,
      id: messageId,
      messageTimer: this.messageTimer.getMessageTimer(conversationId),
      source: PayloadBundleSource.LOCAL,
      state: PayloadBundleState.OUTGOING_SENT,
      timestamp: Date.now(),
      type: PayloadBundleType.MESSAGE_DELETE,
    };
  }

  private shouldSendAsExternal(plainText: Uint8Array, preKeyBundles: UserPreKeyBundleMap): boolean {
    const EXTERNAL_MESSAGE_THRESHOLD_BYTES = 200 * 1024;

    let clientCount = 0;
    for (const user in preKeyBundles) {
      clientCount += Object.keys(preKeyBundles[user]).length;
    }

    const messageInBytes = new Uint8Array(plainText).length;
    const estimatedPayloadInBytes = clientCount * messageInBytes;

    return estimatedPayloadInBytes > EXTERNAL_MESSAGE_THRESHOLD_BYTES;
  }

  public leaveConversation(conversationId: string): Promise<ConversationMemberLeaveEvent> {
    return this.apiClient.conversation.api.deleteMember(conversationId, this.apiClient.context!.userId);
  }

  public async leaveConversations(conversationIds?: string[]): Promise<ConversationMemberLeaveEvent[]> {
    if (!conversationIds) {
      const conversation = await this.getConversations();
      conversationIds = conversation
        .filter(conversation => conversation.type === CONVERSATION_TYPE.REGULAR)
        .map(conversation => conversation.id);
    }

    return Promise.all(conversationIds.map(conversationId => this.leaveConversation(conversationId)));
  }

  public createConversation(name: string, otherUserIds: string | string[] = []): Promise<Conversation> {
    const ids = typeof otherUserIds === 'string' ? [otherUserIds] : otherUserIds;

    const newConversation: NewConversation = {
      name,
      receipt_mode: null,
      users: ids,
    };

    return this.apiClient.conversation.api.postConversation(newConversation);
  }

  public async getConversations(conversationId: string): Promise<Conversation>;
  public async getConversations(conversationIds?: string[]): Promise<Conversation[]>;
  public async getConversations(conversationIds?: string | string[]): Promise<Conversation[] | Conversation> {
    if (!conversationIds || !conversationIds.length) {
      return this.apiClient.conversation.api.getAllConversations();
    }
    if (typeof conversationIds === 'string') {
      return this.apiClient.conversation.api.getConversation(conversationIds);
    }
    return this.apiClient.conversation.api.getConversationsByIds(conversationIds);
  }

  public async getAsset({assetId, assetToken, otrKey, sha256}: RemoteData): Promise<Buffer> {
    const request = await this.apiClient.asset.api.getAssetV3(assetId, assetToken);
    const encryptedBuffer = (await request.response).buffer;

    return AssetCryptography.decryptAsset({
      cipherText: Buffer.from(encryptedBuffer),
      keyBytes: Buffer.from(otrKey),
      sha256: Buffer.from(sha256),
    });
  }

  public async getUnencryptedAsset(assetId: string, assetToken?: string): Promise<ArrayBuffer> {
    const request = await this.apiClient.asset.api.getAssetV3(assetId, assetToken);
    return (await request.response).buffer;
  }

  public async addUser<T extends string | string[] | QualifiedId | QualifiedId[]>(
    conversationId: string,
    userIds: T,
  ): Promise<T> {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    if (isStringArray(ids)) {
      await this.apiClient.conversation.api.postMembers(conversationId, ids);
    } else if (isQualifiedIdArray(ids)) {
      await this.apiClient.conversation.api.postMembersV2(conversationId, ids);
    }

    return userIds;
  }

  public async removeUser(conversationId: string, userId: string): Promise<string> {
    await this.apiClient.conversation.api.deleteMember(conversationId, userId);
    return userId;
  }

  /**
   * Sends a message to a conversation
   *
   * @param params.payloadBundle The message to send to the conversation
   * @param params.userIds? Can be either a QualifiedId[], string[], UserClients or QualfiedUserClients. The type has some effect on the behavior of the method.
   *    When given a QualifiedId[] or string[] the method will fetch the freshest list of devices for those users (since they are not given by the consumer). As a consequence no ClientMismatch error will trigger and we will ignore missing clients when sending
   *    When given a QualifiedUserClients or UserClients the method will only send to the clients listed in the userIds. This could lead to ClientMismatch (since the given list of devices might not be the freshest one and new clients could have been created)
   *    When given a QualifiedId[] or QualifiedUserClients the method will send the message through the federated API endpoint
   *    When given a string[] or UserClients the method will send the message through the old API endpoint
   * @param params.sendAsProtobuf?
   * @param params.conversationDomain? The domain the conversation lives on (if given with QualifiedId[] or QualfiedUserClients in the userIds params, will send the message to the federated endpoint)
   * @param params.callbacks? Optional callbacks that will be called when the message starts being sent and when it has been succesfully sent.
   * @param [callbacks.onClientMismatch] Will be called when a mismatch happens. Returning `false` from the callback will stop the sending attempt
   * @return resolves with the sent message
   */
  public async send<T extends OtrMessage = OtrMessage>({
    payloadBundle,
    userIds,
    sendAsProtobuf,
    conversationDomain,
    callbacks,
  }: {
    payloadBundle: T;
    userIds?: string[] | QualifiedId[] | UserClients | QualifiedUserClients;
    sendAsProtobuf?: boolean;
    conversationDomain?: string;
    callbacks?: MessageSendingCallbacks;
  }): Promise<T> {
    let genericMessage: GenericMessage;
    let processedContent: AssetContent | undefined = undefined;

    switch (payloadBundle.type) {
      case PayloadBundleType.ASSET:
        genericMessage = this.generateFileDataGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.ASSET_ABORT:
        genericMessage = this.generateFileAbortGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.ASSET_META:
        genericMessage = this.generateFileMetaDataGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.ASSET_IMAGE:
        const res = this.generateImageGenericMessage(payloadBundle as ImageAssetMessageOutgoing);
        genericMessage = res.genericMessage;
        processedContent = res.content;
        break;
      case PayloadBundleType.BUTTON_ACTION:
        genericMessage = this.generateButtonActionGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.BUTTON_ACTION_CONFIRMATION:
        genericMessage = this.generateButtonActionConfirmationGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.CALL:
        genericMessage = this.generateCallGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.CLIENT_ACTION: {
        if (payloadBundle.content.clientAction !== ClientAction.RESET_SESSION) {
          throw new Error(
            `No send method implemented for "${payloadBundle.type}" and ClientAction "${payloadBundle.content}".`,
          );
        }
        genericMessage = this.generateSessionResetGenericMessage(payloadBundle);
        break;
      }
      case PayloadBundleType.COMPOSITE:
        genericMessage = this.generateCompositeGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.CONFIRMATION:
        genericMessage = this.generateConfirmationGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.LOCATION:
        genericMessage = this.generateLocationGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.MESSAGE_EDIT:
        genericMessage = this.generateEditedTextGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.PING:
        genericMessage = this.generatePingGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.REACTION:
        genericMessage = this.generateReactionGenericMessage(payloadBundle);
        break;
      case PayloadBundleType.TEXT:
        genericMessage = this.generateTextGenericMessage(payloadBundle);
        break;
      default:
        throw new Error(`No send method implemented for "${payloadBundle['type']}".`);
    }

    callbacks?.onStart?.(genericMessage);
    const response = await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      {userIds, sendAsProtobuf, domain: conversationDomain, onClientMismatch: callbacks?.onClientMismatch},
    );
    callbacks?.onSuccess?.(genericMessage, response?.time);

    return {
      ...payloadBundle,
      content: processedContent || payloadBundle.content,
      messageTimer: genericMessage.ephemeral?.expireAfterMillis || 0,
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  public sendTypingStart(conversationId: string): Promise<void> {
    return this.apiClient.conversation.api.postTyping(conversationId, {status: CONVERSATION_TYPING.STARTED});
  }

  public sendTypingStop(conversationId: string): Promise<void> {
    return this.apiClient.conversation.api.postTyping(conversationId, {status: CONVERSATION_TYPING.STOPPED});
  }

  public setConversationMutedStatus(
    conversationId: string,
    status: MutedStatus,
    muteTimestamp: number | Date,
  ): Promise<void> {
    if (typeof muteTimestamp === 'number') {
      muteTimestamp = new Date(muteTimestamp);
    }

    const payload: ConversationMemberUpdateData = {
      otr_muted_ref: muteTimestamp.toISOString(),
      otr_muted_status: status,
    };

    return this.apiClient.conversation.api.putMembershipProperties(conversationId, payload);
  }

  public toggleArchiveConversation(
    conversationId: string,
    archived: boolean,
    archiveTimestamp: number | Date = new Date(),
  ): Promise<void> {
    if (typeof archiveTimestamp === 'number') {
      archiveTimestamp = new Date(archiveTimestamp);
    }

    const payload: ConversationMemberUpdateData = {
      otr_archived: archived,
      otr_archived_ref: archiveTimestamp.toISOString(),
    };

    return this.apiClient.conversation.api.putMembershipProperties(conversationId, payload);
  }

  public setMemberConversationRole(
    conversationId: string,
    userId: string,
    conversationRole: DefaultConversationRoleName | string,
  ): Promise<void> {
    return this.apiClient.conversation.api.putOtherMember(userId, conversationId, {
      conversation_role: conversationRole,
    });
  }
}
