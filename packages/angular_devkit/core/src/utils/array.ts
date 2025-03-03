/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
/** @deprecated Since v12.0, unused by the Angular tooling */
export function clean<T>(array: Array<T | undefined>): Array<T> {
  return array.filter(x => x !== undefined) as Array<T>;
}
