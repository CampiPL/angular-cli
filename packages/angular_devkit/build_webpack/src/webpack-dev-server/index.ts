/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { BuilderContext, createBuilder } from '@angular-devkit/architect';
import * as net from 'net';
import { resolve as pathResolve } from 'path';
import { Observable, from, isObservable, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';
import { getEmittedFiles } from '../utils';
import { BuildResult, WebpackFactory, WebpackLoggingCallback } from '../webpack';
import { Schema as WebpackDevServerBuilderSchema } from './schema';

export type WebpackDevServerFactory = typeof WebpackDevServer;

export type DevServerBuildOutput = BuildResult & {
  port: number;
  family: string;
  address: string;
};

export function runWebpackDevServer(
  config: webpack.Configuration,
  context: BuilderContext,
  options: {
    devServerConfig?: WebpackDevServer.Configuration,
    logging?: WebpackLoggingCallback,
    webpackFactory?: WebpackFactory,
    webpackDevServerFactory?: WebpackDevServerFactory,
  } = {},
): Observable<DevServerBuildOutput> {
  const createWebpack = (c: webpack.Configuration) => {
    if (options.webpackFactory) {
      const result = options.webpackFactory(c);
      if (isObservable(result)) {
        return result;
      } else {
        return of(result);
      }
    } else {
      return of(webpack(c));
    }
  };

  const createWebpackDevServer = (
    webpack: webpack.Compiler | webpack.MultiCompiler,
    config: WebpackDevServer.Configuration,
  ) => {
    if (options.webpackDevServerFactory) {
      // webpack-dev-server types currently do not support Webpack 5
      // tslint:disable-next-line: no-any
      return new options.webpackDevServerFactory(webpack as any, config);
    }

    // webpack-dev-server types currently do not support Webpack 5
    // tslint:disable-next-line: no-any
    return new WebpackDevServer(webpack as any, config);
  };

  const log: WebpackLoggingCallback = options.logging
    || ((stats, config) => context.logger.info(stats.toString(config.stats)));

  // tslint:disable-next-line: no-any
  const devServerConfig = options.devServerConfig || (config as any).devServer || {};
  if (devServerConfig.stats) {
    config.stats = devServerConfig.stats;
  }
  // Disable stats reporting by the devserver, we have our own logger.
  devServerConfig.stats = false;

  return createWebpack({ ...config, watch: false }).pipe(
    switchMap(webpackCompiler => new Observable<DevServerBuildOutput>(obs => {
      const server = createWebpackDevServer(webpackCompiler, devServerConfig);
      let result: Partial<DevServerBuildOutput>;

      webpackCompiler.hooks.done.tap('build-webpack', (stats) => {
        // Log stats.
        log(stats, config);

        obs.next({
          ...result,
          emittedFiles: getEmittedFiles(stats.compilation),
          success: !stats.hasErrors(),
          outputPath: stats.compilation.outputOptions.path,
        } as unknown as DevServerBuildOutput);
      });

      server.listen(
        devServerConfig.port === undefined ? 8080 : devServerConfig.port,
        devServerConfig.host === undefined ? 'localhost' : devServerConfig.host,
        function (this: net.Server, err) {
          if (err) {
            obs.error(err);
          } else {
            const address = this.address();
            if (!address) {
              obs.error(new Error(`Dev-server address info is not defined.`));

              return;
            }

            result = {
              success: true,
              port: typeof address === 'string' ? 0 : address.port,
              family: typeof address === 'string' ? '' : address.family,
              address: typeof address === 'string' ? address : address.address,
            };
          }
        },
      );

      // Teardown logic. Close the server when unsubscribed from.
      return (() => {
        server.close();
        webpackCompiler.close?.(() => {});
      });
    })),
  );
}


export default createBuilder<WebpackDevServerBuilderSchema, DevServerBuildOutput>(
  (options, context) => {
    const configPath = pathResolve(context.workspaceRoot, options.webpackConfig);

    return from(import(configPath)).pipe(
      switchMap((config: webpack.Configuration) => runWebpackDevServer(config, context)),
    );
  },
);
