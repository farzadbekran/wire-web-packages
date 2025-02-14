/*
 * Wire
 * Copyright (C) 2023 Wire Swiss GmbH
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

import {PreKey} from '@wireapp/api-client/lib/auth';
import {Encoder} from 'bazinga64';

import {CoreCrypto} from '@wireapp/core-crypto';
import type {CRUDEngine} from '@wireapp/store-engine';

import {CryptoClient, LAST_PREKEY_ID} from './CryptoClient.types';
import {PrekeyTracker} from './PrekeysTracker';

import {CoreDatabase} from '../../../../storage/CoreDB';

type Config = {
  nbPrekeys: number;
  onNewPrekeys: (prekeys: PreKey[]) => void;
};

export async function buildClient(
  storeEngine: CRUDEngine,
  secretKey: Uint8Array,
  coreCryptoWasmFilePath: string,
  db: CoreDatabase,
  {nbPrekeys, onNewPrekeys}: Config,
): Promise<CoreCryptoWrapper> {
  const coreCrypto = await CoreCrypto.deferredInit(
    `corecrypto-${storeEngine.storeName}`,
    Encoder.toBase64(secretKey).asString,
    undefined, // We pass a placeholder entropy data. It will be set later on by calling `reseedRng`
    coreCryptoWasmFilePath,
  );
  return new CoreCryptoWrapper(coreCrypto, db, {nbPrekeys, onNewPrekeys});
}

export class CoreCryptoWrapper implements CryptoClient {
  private readonly prekeyTracker: PrekeyTracker;

  constructor(private readonly coreCrypto: CoreCrypto, db: CoreDatabase, config: Config) {
    this.prekeyTracker = new PrekeyTracker(this, db, config);
  }

  getNativeClient() {
    return this.coreCrypto;
  }

  encrypt(sessions: string[], plainText: Uint8Array) {
    return this.coreCrypto.proteusEncryptBatched(sessions, plainText);
  }

  decrypt(sessionId: string, message: Uint8Array) {
    return this.coreCrypto.proteusDecrypt(sessionId, message);
  }

  init() {
    return this.coreCrypto.proteusInit();
  }

  async create(nbPrekeys: number, entropy?: Uint8Array) {
    if (entropy) {
      await this.coreCrypto.reseedRng(entropy);
    }
    await this.init();
    const prekeys: PreKey[] = [];
    for (let id = 0; id < nbPrekeys; id++) {
      prekeys.push(await this.newPrekey(id));
    }
    await this.prekeyTracker.setInitialState(prekeys.length);

    return {
      prekeys,
      lastPrekey: await this.newPrekey(LAST_PREKEY_ID),
    };
  }

  getFingerprint() {
    return this.coreCrypto.proteusFingerprint();
  }

  getRemoteFingerprint(sessionId: string) {
    return this.coreCrypto.proteusFingerprintRemote(sessionId);
  }

  async sessionFromMessage(sessionId: string, message: Uint8Array) {
    await this.consumePrekey(); // we need to mark a prekey as consumed since if we create a session from a message, it means the sender has consumed one of our prekeys
    return this.coreCrypto.proteusSessionFromMessage(sessionId, message);
  }

  sessionFromPrekey(sessionId: string, prekey: Uint8Array) {
    return this.coreCrypto.proteusSessionFromPrekey(sessionId, prekey);
  }

  sessionExists(sessionId: string) {
    return this.coreCrypto.proteusSessionExists(sessionId);
  }

  saveSession(sessionId: string) {
    return this.coreCrypto.proteusSessionSave(sessionId);
  }

  deleteSession(sessionId: string) {
    return this.coreCrypto.proteusSessionDelete(sessionId);
  }

  consumePrekey() {
    return this.prekeyTracker.consumePrekey();
  }

  async newPrekey(id: number) {
    const key = await this.coreCrypto.proteusNewPrekey(id);
    return {id, key: Encoder.toBase64(key).asString};
  }

  async debugBreakSession(sessionId: string) {
    const fakePrekey = [
      165, 0, 1, 1, 24, 57, 2, 161, 0, 88, 32, 212, 202, 30, 83, 242, 93, 67, 164, 202, 137, 214, 167, 166, 183, 236,
      249, 32, 21, 117, 247, 56, 223, 135, 170, 3, 151, 16, 228, 165, 186, 124, 208, 3, 161, 0, 161, 0, 88, 32, 123,
      200, 16, 166, 184, 70, 21, 81, 43, 80, 21, 231, 182, 142, 51, 220, 131, 162, 11, 255, 162, 74, 78, 162, 95, 156,
      131, 48, 203, 5, 77, 122, 4, 246,
    ];
    await this.coreCrypto.proteusSessionFromPrekey(sessionId, Uint8Array.from(fakePrekey));
  }

  async debugResetIdentity() {
    await this.coreCrypto.wipe();
  }

  async migrateFromCryptobox(dbName: string) {
    return this.coreCrypto.proteusCryptoboxMigrate(dbName);
  }

  async wipe() {
    return this.coreCrypto.wipe();
  }
}
