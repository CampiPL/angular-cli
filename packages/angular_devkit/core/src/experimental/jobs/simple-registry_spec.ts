/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

// tslint:disable:no-big-function no-non-null-assertion
import { createJobHandler } from './create-job-handler';
import { SimpleJobRegistry } from './simple-registry';

describe('SimpleJobRegistry', () => {
  let registry: SimpleJobRegistry;

  beforeEach(() => {
    registry = new SimpleJobRegistry();
  });

  it('works for a simple case', async () => {
    registry.register(
      'add', createJobHandler((arg: number[]) => arg.reduce((a, c) => a + c, 0)), {
        argument: { items: { type: 'number' } },
        output: { type: 'number' },
      },
    );

    expect(await registry.get('add').toPromise()).not.toBeNull();
    expect(await registry.get('add2').toPromise()).toBeNull();
  });
});
