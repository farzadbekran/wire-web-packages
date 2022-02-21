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
import type {NewClient, RegisteredClient} from '@wireapp/api-client/src/client/';

export class ClientBackendRepository {
  constructor(private readonly apiClient: APIClient) {}

  public getClients(): Promise<RegisteredClient[]> {
    return this.apiClient.api.client.getClients();
  }

  public postClient(client: NewClient): Promise<RegisteredClient> {
    return this.apiClient.api.client.postClient(client);
  }
}
