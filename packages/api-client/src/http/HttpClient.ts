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

import {EventEmitter} from 'events';
import {PriorityQueue} from '@wireapp/priority-queue';
import {TimeUtil} from '@wireapp/commons';
import axios, {AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse} from 'axios';
import logdown from 'logdown';

import {
  AccessTokenData,
  AccessTokenStore,
  AuthAPI,
  InvalidTokenError,
  MissingCookieError,
  TokenExpiredError,
} from '../auth/';
import {BackendError, BackendErrorMapper, ConnectionState, ContentType, StatusCode} from '../http/';
import {ObfuscationUtil} from '../obfuscation/';
import {sendRequestWithCookie} from '../shims/node/cookie';
import {Config} from '../Config';
import axiosRetry, {isNetworkOrIdempotentRequestError} from 'axios-retry';

enum TOPIC {
  ON_CONNECTION_STATE_CHANGE = 'HttpClient.TOPIC.ON_CONNECTION_STATE_CHANGE',
  ON_INVALID_TOKEN = 'HttpClient.TOPIC.ON_INVALID_TOKEN',
}

export interface HttpClient {
  on(event: TOPIC.ON_CONNECTION_STATE_CHANGE, listener: (state: ConnectionState) => void): this;

  on(event: TOPIC.ON_INVALID_TOKEN, listener: (error: InvalidTokenError | MissingCookieError) => void): this;
}

const FILE_SIZE_100_MB = 104857600;

export class HttpClient extends EventEmitter {
  private readonly client: AxiosInstance;
  private readonly logger: logdown.Logger;
  private connectionState: ConnectionState;
  private readonly requestQueue: PriorityQueue;
  public static readonly TOPIC = TOPIC;
  private versionPrefix = '';

  constructor(private readonly config: Config, public accessTokenStore: AccessTokenStore) {
    super();

    this.client = axios.create({
      baseURL: this.config.urls.rest,
    });
    axiosRetry(this.client, {
      retries: Infinity,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        const {response, request} = error;

        const isNetworkError = !response && request && !Object.keys(request).length;
        if (isNetworkError) {
          this.logger.warn('Disconnected from backend');
          this.updateConnectionState(ConnectionState.DISCONNECTED);
          return true;
        }

        return isNetworkOrIdempotentRequestError(error);
      },
      shouldResetTimeout: true,
    });

    this.connectionState = ConnectionState.UNDEFINED;

    this.logger = logdown('@wireapp/api-client/http/HttpClient', {
      logger: console,
      markdown: false,
    });

    this.requestQueue = new PriorityQueue({
      maxRetries: 0,
      retryDelay: TimeUtil.TimeInMillis.SECOND,
    });
  }

  public useVersion(version: number): void {
    this.versionPrefix = version > 0 ? `/v${version}` : '';
  }

  private updateConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      this.emit(HttpClient.TOPIC.ON_CONNECTION_STATE_CHANGE, this.connectionState);
    }
  }

  public async _sendRequest<T>(
    config: AxiosRequestConfig,
    tokenAsParam = false,
    isFirstTry = true,
  ): Promise<AxiosResponse<T>> {
    if (this.accessTokenStore.accessToken) {
      const {token_type, access_token} = this.accessTokenStore.accessToken;

      if (tokenAsParam) {
        config.params = {
          ...config.params,
          access_token,
        };
      } else {
        config.headers = {
          ...config.headers,
          Authorization: `${token_type} ${access_token}`,
        };
      }
    }

    try {
      const response = await this.client.request<T>({
        ...config,
        // We want to prefix all urls, except the ones with cookies which are attached to unprefixed urls
        url: config.withCredentials ? config.url : `${this.versionPrefix}${config.url}`,
        maxBodyLength: FILE_SIZE_100_MB,
        maxContentLength: FILE_SIZE_100_MB,
      });

      this.updateConnectionState(ConnectionState.CONNECTED);

      return response;
    } catch (error) {
      const retryWithTokenRefresh = async () => {
        this.logger.warn(`Access token refresh triggered for "${config.method}" request to "${config.url}".`);
        await this.refreshAccessToken();
        config['axios-retry'] = {
          retries: 0,
        };
        return this._sendRequest<T>(config, tokenAsParam, false);
      };

      const hasAccessToken = !!this.accessTokenStore?.accessToken;

      if (HttpClient.isAxiosError(error) && error.response?.status === StatusCode.UNAUTHORIZED) {
        return retryWithTokenRefresh();
      }

      if (HttpClient.isBackendError(error)) {
        const mappedError = BackendErrorMapper.map(
          new BackendError(error.response.data.message, error.response.data.label, error.response.data.code),
        );

        const isUnauthorized = mappedError.code === StatusCode.UNAUTHORIZED;
        const isExpiredTokenError = mappedError instanceof TokenExpiredError;

        if ((isExpiredTokenError || isUnauthorized) && hasAccessToken && isFirstTry) {
          return retryWithTokenRefresh();
        }

        if (mappedError instanceof InvalidTokenError || mappedError instanceof MissingCookieError) {
          // On invalid cookie the application is supposed to logout.
          this.logger.warn(
            `Cannot renew access token for "${config.method}" request to "${config.url}" because cookie/token is invalid: ${mappedError.message}`,
            mappedError,
          );
          this.emit(HttpClient.TOPIC.ON_INVALID_TOKEN, mappedError);
        }

        throw mappedError;
      }

      throw error;
    }
  }

  static isAxiosError(errorCandidate: any): errorCandidate is AxiosError {
    return errorCandidate.isAxiosError === true;
  }

  static isBackendError(errorCandidate: any): errorCandidate is AxiosError<BackendError> & {response: BackendError} {
    if (errorCandidate.response) {
      const {data} = errorCandidate.response;
      return !!data?.code && !!data?.label && !!data?.message;
    }
    return false;
  }

  public async refreshAccessToken(): Promise<AccessTokenData> {
    let expiredAccessToken: AccessTokenData | undefined;
    if (this.accessTokenStore.accessToken?.access_token) {
      expiredAccessToken = this.accessTokenStore.accessToken;
    }

    const accessToken = await this.postAccess(expiredAccessToken);
    this.logger.info(
      `Received updated access token. It will expire in "${accessToken.expires_in}" seconds.`,
      ObfuscationUtil.obfuscateAccessToken(accessToken),
    );
    return this.accessTokenStore.updateToken(accessToken);
  }

  public async postAccess(expiredAccessToken?: AccessTokenData): Promise<AccessTokenData> {
    const config: AxiosRequestConfig = {
      headers: {},
      method: 'post',
      url: `${AuthAPI.URL.ACCESS}`,
      withCredentials: true,
    };

    if (expiredAccessToken?.access_token) {
      config.headers.Authorization = `${expiredAccessToken.token_type} ${decodeURIComponent(
        expiredAccessToken.access_token,
      )}`;
    }

    const response = await sendRequestWithCookie<AccessTokenData>(this, config);
    return response.data;
  }

  public async sendRequest<T>(
    config: AxiosRequestConfig,
    tokenAsParam: boolean = false,
    isSynchronousRequest: boolean = false,
  ): Promise<AxiosResponse<T>> {
    return isSynchronousRequest
      ? this.requestQueue.add(() => this._sendRequest<T>(config, tokenAsParam))
      : this._sendRequest<T>(config, tokenAsParam);
  }

  public sendJSON<T>(config: AxiosRequestConfig, isSynchronousRequest: boolean = false): Promise<AxiosResponse<T>> {
    config.headers = {
      ...config.headers,
      'Content-Type': ContentType.APPLICATION_JSON,
    };
    return this.sendRequest<T>(config, false, isSynchronousRequest);
  }

  public sendXML<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    config.headers = {
      ...config.headers,
      'Content-Type': ContentType.APPLICATION_XML,
    };
    return this.sendRequest<T>(config, false, false);
  }

  public sendProtocolBuffer<T>(
    config: AxiosRequestConfig,
    isSynchronousRequest: boolean = false,
  ): Promise<AxiosResponse<T>> {
    config.headers = {
      ...config.headers,
      'Content-Type': ContentType.APPLICATION_PROTOBUF,
    };
    return this.sendRequest<T>(config, false, isSynchronousRequest);
  }
}
