/*
 * Wire
 * Copyright (C) 2021 Wire Swiss GmbH
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

import {Role} from '..';
import {User, ManagedSource} from '../../user/';

export type TeamContact = Pick<User, 'id' | 'email' | 'accent_id' | 'handle' | 'name' | 'team'> & {
  /** Timestamp of invitation creation. */
  created_at?: string;
  managed_by?: ManagedSource;
  role?: Role;
  /** URL of the SAML identity provider. */
  saml_idp?: string;
};
