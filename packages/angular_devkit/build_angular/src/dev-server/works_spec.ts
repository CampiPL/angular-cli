/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { Architect, BuilderRun } from '@angular-devkit/architect';
import { DevServerBuilderOutput } from '@angular-devkit/build-angular';
import { normalize, virtualFs } from '@angular-devkit/core';
import fetch from 'node-fetch'; // tslint:disable-line:no-implicit-dependencies
import { createArchitect, host } from '../test-utils';


describe('Dev Server Builder', () => {
  const target = { project: 'app', target: 'serve' };
  let architect: Architect;
  let runs: BuilderRun[] = [];

  beforeEach(async () => {
    await host.initialize().toPromise();
    architect = (await createArchitect(host.root())).architect;
    runs = [];
  });
  afterEach(async () => {
    await host.restore().toPromise();
    await Promise.all(runs.map(r => r.stop()));
  });

  it(`doesn't serve files on the cwd directly`, async () => {
    const run = await architect.scheduleTarget(target);
    runs.push(run);
    const output = await run.result as DevServerBuilderOutput;
    expect(output.success).toBe(true);

    // When webpack-dev-server doesn't have `contentBase: false`, this will serve the repo README.
    const response = await fetch('http://localhost:4200/README.md', {
      headers: {
        'Accept': 'text/html',
      },
    });

    const res = await response.text();
    expect(res).not.toContain('This file is automatically generated during release.');
    expect(res).toContain('<title>HelloWorldApp</title>');
  });

  it('should not generate sourcemaps when running prod build', async () => {
    // Production builds have sourcemaps turned off.
    const run = await architect.scheduleTarget({ ...target, configuration: 'production' }, { port: 0 });
    runs.push(run);
    const output = await run.result as DevServerBuilderOutput;
    expect(output.success).toBe(true);
    const hasSourceMaps = output.emittedFiles && output.emittedFiles.some(f => f.extension === '.map');
    expect(hasSourceMaps).toBe(false, `Expected emitted files not to contain '.map' files.`);
  });

  it('serves custom headers', async () => {
    const run = await architect.scheduleTarget(
        target, {headers: {'X-Header': 'Hello World'}, port: 0});
    runs.push(run);
    const output = await run.result as DevServerBuilderOutput;
    expect(output.success).toBe(true);
    const response = await fetch(output.baseUrl);
    expect(response.headers.get('X-Header')).toBe('Hello World');
  });

  it('uses source locale when not localizing', async () => {
    const config = host.scopedSync().read(normalize('angular.json'));
    const jsonConfig = JSON.parse(virtualFs.fileBufferToString(config));
    const applicationProject = jsonConfig.projects.app;

    applicationProject.i18n = { sourceLocale: 'fr' };

    host.writeMultipleFiles({
      'angular.json': JSON.stringify(jsonConfig),
    });

    const architect = (await createArchitect(host.root())).architect;
    const run = await architect.scheduleTarget(target, { port: 0 });
    const output = await run.result as DevServerBuilderOutput;
    expect(output.success).toBe(true);

    const indexResponse = await fetch(output.baseUrl);
    expect(await indexResponse.text()).toContain('lang="fr"');
    const vendorResponse = await fetch(output.baseUrl + 'vendor.js');
    const vendorText = await vendorResponse.text();
    expect(vendorText).toContain('fr');
    expect(vendorText).toContain('octobre');

    await run.stop();
  });

});
