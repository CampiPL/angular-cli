/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { analytics, tags } from '@angular-devkit/core';
import { NodePackageDoesNotSupportSchematics } from '@angular-devkit/schematics/tools';
import { dirname, join } from 'path';
import { intersects, prerelease, rcompare, satisfies, valid, validRange } from 'semver';
import { PackageManager } from '../lib/config/workspace-schema';
import { isPackageNameSafeForAnalytics } from '../models/analytics';
import { Arguments } from '../models/interface';
import { RunSchematicOptions, SchematicCommand } from '../models/schematic-command';
import { colors } from '../utilities/color';
import { installPackage, installTempPackage } from '../utilities/install-package';
import { ensureCompatibleNpm, getPackageManager } from '../utilities/package-manager';
import {
  NgAddSaveDepedency,
  PackageManifest,
  fetchPackageManifest,
  fetchPackageMetadata,
} from '../utilities/package-metadata';
import { askConfirmation } from '../utilities/prompt';
import { Spinner } from '../utilities/spinner';
import { isTTY } from '../utilities/tty';
import { Schema as AddCommandSchema } from './add';

const npa = require('npm-package-arg');

export class AddCommand extends SchematicCommand<AddCommandSchema> {
  readonly allowPrivateSchematics = true;

  async initialize(options: AddCommandSchema & Arguments) {
    if (options.registry) {
      return super.initialize({ ...options, packageRegistry: options.registry });
    } else {
      return super.initialize(options);
    }
  }

  async run(options: AddCommandSchema & Arguments) {
    await ensureCompatibleNpm(this.context.root);

    if (!options.collection) {
      this.logger.fatal(
        `The "ng add" command requires a name argument to be specified eg. ` +
          `${colors.yellow('ng add [name] ')}. For more details, use "ng help".`,
      );

      return 1;
    }

    let packageIdentifier;
    try {
      packageIdentifier = npa(options.collection);
    } catch (e) {
      this.logger.error(e.message);

      return 1;
    }

    if (packageIdentifier.registry && this.isPackageInstalled(packageIdentifier.name)) {
      let validVersion = false;
      const installedVersion = await this.findProjectVersion(packageIdentifier.name);
      if (installedVersion) {
        if (packageIdentifier.type === 'range') {
          validVersion = satisfies(installedVersion, packageIdentifier.fetchSpec);
        } else if (packageIdentifier.type === 'version') {
          const v1 = valid(packageIdentifier.fetchSpec);
          const v2 = valid(installedVersion);
          validVersion = v1 !== null && v1 === v2;
        } else if (!packageIdentifier.rawSpec) {
          validVersion = true;
        }
      }

      if (validVersion) {
        // Already installed so just run schematic
        this.logger.info('Skipping installation: Package already installed');

        return this.executeSchematic(packageIdentifier.name, options['--']);
      }
    }

    const spinner = new Spinner();

    spinner.start('Determining package manager...');
    const packageManager = await getPackageManager(this.context.root);
    const usingYarn = packageManager === PackageManager.Yarn;
    spinner.info(`Using package manager: ${colors.grey(packageManager)}`);

    if (packageIdentifier.type === 'tag' && !packageIdentifier.rawSpec) {
      // only package name provided; search for viable version
      // plus special cases for packages that did not have peer deps setup
      spinner.start('Searching for compatible package version...');

      let packageMetadata;
      try {
        packageMetadata = await fetchPackageMetadata(packageIdentifier.name, this.logger, {
          registry: options.registry,
          usingYarn,
          verbose: options.verbose,
        });
      } catch (e) {
        spinner.fail('Unable to load package information from registry: ' + e.message);

        return 1;
      }

      const latestManifest = packageMetadata.tags['latest'];
      if (latestManifest && Object.keys(latestManifest.peerDependencies).length === 0) {
        if (latestManifest.name === '@angular/pwa') {
          const version = await this.findProjectVersion('@angular/cli');
          const semverOptions = { includePrerelease: true };

          if (
            version &&
            ((validRange(version) && intersects(version, '7', semverOptions)) ||
              (valid(version) && satisfies(version, '7', semverOptions)))
          ) {
            packageIdentifier = npa.resolve('@angular/pwa', '0.12');
          }
        } else {
          packageIdentifier = npa.resolve(latestManifest.name, latestManifest.version);
        }
        spinner.succeed(`Found compatible package version: ${colors.grey(packageIdentifier)}.`);
      } else if (!latestManifest || (await this.hasMismatchedPeer(latestManifest))) {
        // 'latest' is invalid so search for most recent matching package
        const versionManifests = Object.values(packageMetadata.versions).filter(
          (value: PackageManifest) => !prerelease(value.version) && !value.deprecated,
        ) as PackageManifest[];

        versionManifests.sort((a, b) => rcompare(a.version, b.version, true));

        let newIdentifier;
        for (const versionManifest of versionManifests) {
          if (!(await this.hasMismatchedPeer(versionManifest))) {
            newIdentifier = npa.resolve(packageIdentifier.name, versionManifest.version);
            break;
          }
        }

        if (!newIdentifier) {
          spinner.warn("Unable to find compatible package.  Using 'latest'.");
        } else {
          packageIdentifier = newIdentifier;
          spinner.succeed(`Found compatible package version: ${colors.grey(packageIdentifier)}.`);
        }
      } else {
        packageIdentifier = npa.resolve(latestManifest.name, latestManifest.version);
        spinner.succeed(`Found compatible package version: ${colors.grey(packageIdentifier)}.`);
      }
    }

    let collectionName = packageIdentifier.name;
    let savePackage: NgAddSaveDepedency | undefined;

    try {
      spinner.start('Loading package information from registry...');
      const manifest = await fetchPackageManifest(packageIdentifier, this.logger, {
        registry: options.registry,
        verbose: options.verbose,
        usingYarn,
      });

      savePackage = manifest['ng-add']?.save;
      collectionName = manifest.name;

      if (await this.hasMismatchedPeer(manifest)) {
        spinner.warn(
          'Package has unmet peer dependencies. Adding the package may not succeed.',
        );
      } else {
        spinner.succeed(`Package information loaded.`);
      }
    } catch (e) {
      spinner.fail(`Unable to fetch package information for '${packageIdentifier}': ${e.message}`);

      return 1;
    }

    if (!options.skipConfirmation) {
      const confirmationResponse = await askConfirmation(
        `\nThe package ${colors.blue(packageIdentifier.raw)} will be installed and executed.\n` +
          'Would you like to proceed?',
        true,
        false,
      );

      if (!confirmationResponse) {
        if (!isTTY) {
          this.logger.error(
            'No terminal detected. ' +
              `'--skip-confirmation' can be used to bypass installation confirmation. ` +
              `Ensure package name is correct prior to '--skip-confirmation' option usage.`,
          );
        }
        this.logger.error('Command aborted.');

        return 1;
      }
    }

    try {
      spinner.start('Installing package...');
      if (savePackage === false) {
        // Temporary packages are located in a different directory
        // Hence we need to resolve them using the temp path
        const tempPath = installTempPackage(
          packageIdentifier.raw,
          undefined,
          packageManager,
          options.registry ? [`--registry="${options.registry}"`] : undefined,
        );
        const resolvedCollectionPath = require.resolve(
          join(collectionName, 'package.json'),
          {
            paths: [tempPath],
          },
        );

        collectionName = dirname(resolvedCollectionPath);
      } else {
        installPackage(
          packageIdentifier.raw,
          undefined,
          packageManager,
          savePackage,
          options.registry ? [`--registry="${options.registry}"`] : undefined,
        );
      }
      spinner.succeed('Package successfully installed.');
    } catch (error) {
      spinner.fail(`Package installation failed: ${error.message}`);

      return 1;
    }

    return this.executeSchematic(collectionName, options['--']);
  }

  async reportAnalytics(
    paths: string[],
    options: AddCommandSchema & Arguments,
    dimensions: (boolean | number | string)[] = [],
    metrics: (boolean | number | string)[] = [],
  ): Promise<void> {
    const collection = options.collection;

    // Add the collection if it's safe listed.
    if (collection && isPackageNameSafeForAnalytics(collection)) {
      dimensions[analytics.NgCliAnalyticsDimensions.NgAddCollection] = collection;
    } else {
      delete dimensions[analytics.NgCliAnalyticsDimensions.NgAddCollection];
    }

    return super.reportAnalytics(paths, options, dimensions, metrics);
  }

  private isPackageInstalled(name: string): boolean {
    try {
      require.resolve(join(name, 'package.json'), { paths: [this.context.root] });

      return true;
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') {
        throw e;
      }
    }

    return false;
  }

  private async executeSchematic(
    collectionName: string,
    options: string[] = [],
  ): Promise<number | void> {
    const runOptions: RunSchematicOptions = {
      schematicOptions: options,
      collectionName,
      schematicName: 'ng-add',
      dryRun: false,
      force: false,
    };

    try {
      return await this.runSchematic(runOptions);
    } catch (e) {
      if (e instanceof NodePackageDoesNotSupportSchematics) {
        this.logger.error(tags.oneLine`
          The package that you are trying to add does not support schematics. You can try using
          a different version of the package or contact the package author to add ng-add support.
        `);

        return 1;
      }

      throw e;
    }
  }

  private async findProjectVersion(name: string): Promise<string | null> {
    let installedPackage;
    try {
      installedPackage = require.resolve(join(name, 'package.json'), {
        paths: [this.context.root],
      });
    } catch {}

    if (installedPackage) {
      try {
        const installed = await fetchPackageManifest(dirname(installedPackage), this.logger);

        return installed.version;
      } catch {}
    }

    let projectManifest;
    try {
      projectManifest = await fetchPackageManifest(this.context.root, this.logger);
    } catch {}

    if (projectManifest) {
      const version = projectManifest.dependencies[name] || projectManifest.devDependencies[name];
      if (version) {
        return version;
      }
    }

    return null;
  }

  private async hasMismatchedPeer(manifest: PackageManifest): Promise<boolean> {
    for (const peer in manifest.peerDependencies) {
      let peerIdentifier;
      try {
        peerIdentifier = npa.resolve(peer, manifest.peerDependencies[peer]);
      } catch {
        this.logger.warn(`Invalid peer dependency ${peer} found in package.`);
        continue;
      }

      if (peerIdentifier.type === 'version' || peerIdentifier.type === 'range') {
        try {
          const version = await this.findProjectVersion(peer);
          if (!version) {
            continue;
          }

          const options = { includePrerelease: true };

          if (
            !intersects(version, peerIdentifier.rawSpec, options) &&
            !satisfies(version, peerIdentifier.rawSpec, options)
          ) {
            return true;
          }
        } catch {
          // Not found or invalid so ignore
          continue;
        }
      } else {
        // type === 'tag' | 'file' | 'directory' | 'remote' | 'git'
        // Cannot accurately compare these as the tag/location may have changed since install
      }
    }

    return false;
  }
}
