/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  logging,
  normalize,
  schema,
  strings,
  tags,
  workspaces,
} from '@angular-devkit/core';
import {
  DryRunEvent,
  UnsuccessfulWorkflowExecution,
  formats,
  workflow,
} from '@angular-devkit/schematics';
import {
  FileSystemCollection,
  FileSystemEngine,
  FileSystemSchematic,
  NodeWorkflow,
} from '@angular-devkit/schematics/tools';
import * as inquirer from 'inquirer';
import * as systemPath from 'path';
import { colors } from '../utilities/color';
import { getProjectByCwd, getSchematicDefaults, getWorkspace } from '../utilities/config';
import { parseJsonSchemaToOptions } from '../utilities/json-schema';
import { ensureCompatibleNpm, getPackageManager } from '../utilities/package-manager';
import { isTTY } from '../utilities/tty';
import { isPackageNameSafeForAnalytics } from './analytics';
import { BaseCommandOptions, Command } from './command';
import { Arguments, CommandContext, CommandDescription, Option } from './interface';
import { parseArguments, parseFreeFormArguments } from './parser';
import { SchematicEngineHost } from './schematic-engine-host';

export interface BaseSchematicSchema {
  debug?: boolean;
  dryRun?: boolean;
  force?: boolean;
  interactive?: boolean;
  defaults?: boolean;
  packageRegistry?: string;
}

export interface RunSchematicOptions extends BaseSchematicSchema {
  collectionName: string;
  schematicName: string;
  additionalOptions?: { [key: string]: {} };
  schematicOptions?: string[];
  showNothingDone?: boolean;
}

export class UnknownCollectionError extends Error {
  constructor(collectionName: string) {
    super(`Invalid collection (${collectionName}).`);
  }
}

export abstract class SchematicCommand<
  T extends BaseSchematicSchema & BaseCommandOptions
> extends Command<T> {
  protected readonly allowPrivateSchematics: boolean = false;
  protected readonly useReportAnalytics = false;
  protected _workflow!: NodeWorkflow;

  protected defaultCollectionName = '@schematics/angular';
  protected collectionName = this.defaultCollectionName;
  protected schematicName?: string;

  constructor(context: CommandContext, description: CommandDescription, logger: logging.Logger) {
    super(context, description, logger);
  }

  public async initialize(options: T & Arguments) {
    await this.createWorkflow(options);

    if (this.schematicName) {
      // Set the options.
      const collection = this.getCollection(this.collectionName);
      const schematic = this.getSchematic(collection, this.schematicName, true);
      const options = await parseJsonSchemaToOptions(
        this._workflow.registry,
        schematic.description.schemaJson || {},
      );

      this.description.options.push(...options.filter(x => !x.hidden));

      // Remove any user analytics from schematics that are NOT part of our safelist.
      for (const o of this.description.options) {
        if (o.userAnalytics && !isPackageNameSafeForAnalytics(this.collectionName)) {
          o.userAnalytics = undefined;
        }
      }
    }
  }

  public async printHelp() {
    await super.printHelp();
    this.logger.info('');

    const subCommandOption = this.description.options.filter(x => x.subcommands)[0];

    if (!subCommandOption || !subCommandOption.subcommands) {
      return 0;
    }

    const schematicNames = Object.keys(subCommandOption.subcommands);

    if (schematicNames.length > 1) {
      this.logger.info('Available Schematics:');

      const namesPerCollection: { [c: string]: string[] } = {};
      schematicNames.forEach(name => {
        let [collectionName, schematicName] = name.split(/:/, 2);
        if (!schematicName) {
          schematicName = collectionName;
          collectionName = this.collectionName;
        }

        if (!namesPerCollection[collectionName]) {
          namesPerCollection[collectionName] = [];
        }

        namesPerCollection[collectionName].push(schematicName);
      });

      const defaultCollection = await this.getDefaultSchematicCollection();
      Object.keys(namesPerCollection).forEach(collectionName => {
        const isDefault = defaultCollection == collectionName;
        this.logger.info(`  Collection "${collectionName}"${isDefault ? ' (default)' : ''}:`);

        namesPerCollection[collectionName].forEach(schematicName => {
          this.logger.info(`    ${schematicName}`);
        });
      });
    } else if (schematicNames.length == 1) {
      this.logger.info('Help for schematic ' + schematicNames[0]);
      await this.printHelpSubcommand(subCommandOption.subcommands[schematicNames[0]]);
    }

    return 0;
  }

  async printHelpUsage() {
    const subCommandOption = this.description.options.filter(x => x.subcommands)[0];

    if (!subCommandOption || !subCommandOption.subcommands) {
      return;
    }

    const schematicNames = Object.keys(subCommandOption.subcommands);
    if (schematicNames.length == 1) {
      this.logger.info(this.description.description);

      const opts = this.description.options.filter(x => x.positional === undefined);
      const [collectionName, schematicName] = schematicNames[0].split(/:/)[0];

      // Display <collectionName:schematicName> if this is not the default collectionName,
      // otherwise just show the schematicName.
      const displayName =
        collectionName == (await this.getDefaultSchematicCollection())
          ? schematicName
          : schematicNames[0];

      const schematicOptions = subCommandOption.subcommands[schematicNames[0]].options;
      const schematicArgs = schematicOptions.filter(x => x.positional !== undefined);
      const argDisplay =
        schematicArgs.length > 0
          ? ' ' + schematicArgs.map(a => `<${strings.dasherize(a.name)}>`).join(' ')
          : '';

      this.logger.info(tags.oneLine`
        usage: ng ${this.description.name} ${displayName}${argDisplay}
        ${opts.length > 0 ? `[options]` : ``}
      `);
      this.logger.info('');
    } else {
      await super.printHelpUsage();
    }
  }

  protected getEngine(): FileSystemEngine {
    return this._workflow.engine;
  }

  protected getCollection(collectionName: string): FileSystemCollection {
    const engine = this.getEngine();
    const collection = engine.createCollection(collectionName);

    if (collection === null) {
      throw new UnknownCollectionError(collectionName);
    }

    return collection;
  }

  protected getSchematic(
    collection: FileSystemCollection,
    schematicName: string,
    allowPrivate?: boolean,
  ): FileSystemSchematic {
    return collection.createSchematic(schematicName, allowPrivate);
  }

  protected setPathOptions(options: Option[], workingDir: string) {
    if (workingDir === '') {
      return {};
    }

    return options
      .filter(o => o.format === 'path')
      .map(o => o.name)
      .reduce(
        (acc, curr) => {
          acc[curr] = workingDir;

          return acc;
        },
        {} as { [name: string]: string },
      );
  }

  /*
   * Runtime hook to allow specifying customized workflow
   */
  protected async createWorkflow(options: BaseSchematicSchema): Promise<workflow.BaseWorkflow> {
    if (this._workflow) {
      return this._workflow;
    }

    const { force, dryRun } = options;
    const root = this.context.root;
    const workflow = new NodeWorkflow(root, {
      force,
      dryRun,
      packageManager: await getPackageManager(root),
      packageRegistry: options.packageRegistry,
      // A schema registry is required to allow customizing addUndefinedDefaults
      registry: new schema.CoreSchemaRegistry(formats.standardFormats),
      resolvePaths: !!this.workspace
        // Workspace
        ? this.collectionName === this.defaultCollectionName
          // Favor __dirname for @schematics/angular to use the build-in version
          ? [__dirname, process.cwd(), root]
          : [process.cwd(), root, __dirname]
        // Global
        : [__dirname, process.cwd()],
      schemaValidation: true,
      optionTransforms: [
        // Add configuration file defaults
        async (schematic, current) => ({
          ...(await getSchematicDefaults(schematic.collection.name, schematic.name, getProjectName())),
          ...current,
        }),
      ],
      engineHostCreator: (options) => new SchematicEngineHost(options.resolvePaths),
    });

    const getProjectName = () => {
      if (this.workspace) {
        const projectNames = getProjectsByPath(this.workspace, process.cwd(), this.workspace.basePath);

        if (projectNames.length === 1) {
          return projectNames[0];
        } else {
          if (projectNames.length > 1) {
            this.logger.warn(tags.oneLine`
              Two or more projects are using identical roots.
              Unable to determine project using current working directory.
              Using default workspace project instead.
            `);
          }

          const defaultProjectName = this.workspace.extensions['defaultProject'];
          if (typeof defaultProjectName === 'string' && defaultProjectName) {
            return defaultProjectName;
          }
        }
      }

      return undefined;
    };

    workflow.registry.addPostTransform(schema.transforms.addUndefinedDefaults);
    workflow.registry.addSmartDefaultProvider('projectName', getProjectName);
    workflow.registry.useXDeprecatedProvider(msg => this.logger.warn(msg));

    let shouldReportAnalytics = true;
    workflow.engineHost.registerOptionsTransform(async (_, options) => {
      if (shouldReportAnalytics) {
        shouldReportAnalytics = false;
        await this.reportAnalytics([this.description.name], options as Arguments);
      }

      return options;
    });

    if (options.interactive !== false && isTTY()) {
      workflow.registry.usePromptProvider((definitions: Array<schema.PromptDefinition>) => {
        const questions: inquirer.QuestionCollection = definitions
          .filter(definition => !options.defaults || definition.default === undefined)
          .map(definition => {
            const question: inquirer.Question = {
              name: definition.id,
              message: definition.message,
              default: definition.default,
            };

            const validator = definition.validator;
            if (validator) {
              question.validate = input => validator(input);

              // Filter allows transformation of the value prior to validation
              question.filter = async (input) => {
                for (const type of definition.propertyTypes) {
                  let value;
                  switch (type) {
                    case 'string':
                      value = String(input);
                      break;
                    case 'integer':
                    case 'number':
                      value = Number(input);
                      break;
                    default:
                      value = input;
                      break;
                  }
                  // Can be a string if validation fails
                  const isValid = (await validator(value)) === true;
                  if (isValid) {
                    return value;
                  }
                }

                return input;
              };
            }

            switch (definition.type) {
              case 'confirmation':
                question.type = 'confirm';
                break;
              case 'list':
                question.type = definition.multiselect ? 'checkbox' : 'list';
                (question as inquirer.CheckboxQuestion).choices = definition.items?.map(item => {
                  return typeof item == 'string'
                    ? item
                    : {
                      name: item.label,
                      value: item.value,
                    };
                });
                break;
              default:
                question.type = definition.type;
                break;
            }

            return question;
          });

        return inquirer.prompt(questions);
      });
    }

    return (this._workflow = workflow);
  }

  protected async getDefaultSchematicCollection(): Promise<string> {
    let workspace = await getWorkspace('local');

    if (workspace) {
      const project = getProjectByCwd(workspace);
      if (project && workspace.getProjectCli(project)) {
        const value = workspace.getProjectCli(project)['defaultCollection'];
        if (typeof value == 'string') {
          return value;
        }
      }
      if (workspace.getCli()) {
        const value = workspace.getCli()['defaultCollection'];
        if (typeof value == 'string') {
          return value;
        }
      }
    }

    workspace = await getWorkspace('global');
    if (workspace && workspace.getCli()) {
      const value = workspace.getCli()['defaultCollection'];
      if (typeof value == 'string') {
        return value;
      }
    }

    return this.defaultCollectionName;
  }

  protected async runSchematic(options: RunSchematicOptions) {
    const { schematicOptions, debug, dryRun } = options;
    let { collectionName, schematicName } = options;

    let nothingDone = true;
    let loggingQueue: string[] = [];
    let error = false;

    const workflow = this._workflow;

    const workingDir = normalize(systemPath.relative(this.context.root, process.cwd()));

    // Get the option object from the schematic schema.
    const schematic = this.getSchematic(
      this.getCollection(collectionName),
      schematicName,
      this.allowPrivateSchematics,
    );
    // Update the schematic and collection name in case they're not the same as the ones we
    // received in our options, e.g. after alias resolution or extension.
    collectionName = schematic.collection.description.name;
    schematicName = schematic.description.name;

    // Set the options of format "path".
    let o: Option[] | null = null;
    let args: Arguments;

    if (!schematic.description.schemaJson) {
      args = await this.parseFreeFormArguments(schematicOptions || []);
    } else {
      o = await parseJsonSchemaToOptions(workflow.registry, schematic.description.schemaJson);
      args = await this.parseArguments(schematicOptions || [], o);
    }

    const allowAdditionalProperties =
      typeof schematic.description.schemaJson === 'object' && schematic.description.schemaJson.additionalProperties;

    if (args['--'] && !allowAdditionalProperties) {
      args['--'].forEach(additional => {
        this.logger.fatal(`Unknown option: '${additional.split(/=/)[0]}'`);
      });

      return 1;
    }

    const pathOptions = o ? this.setPathOptions(o, workingDir) : {};
    let input = { ...pathOptions, ...args };

    // Read the default values from the workspace.
    const projectName = input.project !== undefined ? '' + input.project : null;
    const defaults = await getSchematicDefaults(collectionName, schematicName, projectName);
    input = {
      ...defaults,
      ...input,
      ...options.additionalOptions,
    };

    workflow.reporter.subscribe((event: DryRunEvent) => {
      nothingDone = false;

      // Strip leading slash to prevent confusion.
      const eventPath = event.path.startsWith('/') ? event.path.substr(1) : event.path;

      switch (event.kind) {
        case 'error':
          error = true;
          const desc = event.description == 'alreadyExist' ? 'already exists' : 'does not exist.';
          this.logger.warn(`ERROR! ${eventPath} ${desc}.`);
          break;
        case 'update':
          loggingQueue.push(tags.oneLine`
            ${colors.cyan('UPDATE')} ${eventPath} (${event.content.length} bytes)
          `);
          break;
        case 'create':
          loggingQueue.push(tags.oneLine`
            ${colors.green('CREATE')} ${eventPath} (${event.content.length} bytes)
          `);
          break;
        case 'delete':
          loggingQueue.push(`${colors.yellow('DELETE')} ${eventPath}`);
          break;
        case 'rename':
          const eventToPath = event.to.startsWith('/') ? event.to.substr(1) : event.to;
          loggingQueue.push(`${colors.blue('RENAME')} ${eventPath} => ${eventToPath}`);
          break;
      }
    });

    workflow.lifeCycle.subscribe(event => {
      if (event.kind == 'end' || event.kind == 'post-tasks-start') {
        if (!error) {
          // Output the logging queue, no error happened.
          loggingQueue.forEach(log => this.logger.info(log));
        }

        loggingQueue = [];
        error = false;
      }
    });

    // Temporary compatibility check for NPM 7
    if (collectionName === '@schematics/angular' && schematicName === 'ng-new') {
      if (
        !input.skipInstall &&
        (input.packageManager === undefined || input.packageManager === 'npm')
      ) {
        await ensureCompatibleNpm(this.context.root);
      }
    }

    return new Promise<number | void>(resolve => {
      workflow
        .execute({
          collection: collectionName,
          schematic: schematicName,
          options: input,
          debug: debug,
          logger: this.logger,
          allowPrivate: this.allowPrivateSchematics,
        })
        .subscribe({
          error: (err: Error) => {
            // In case the workflow was not successful, show an appropriate error message.
            if (err instanceof UnsuccessfulWorkflowExecution) {
              // "See above" because we already printed the error.
              this.logger.fatal('The Schematic workflow failed. See above.');
            } else if (debug) {
              this.logger.fatal(`An error occurred:\n${err.message}\n${err.stack}`);
            } else {
              this.logger.fatal(err.message);
            }

            resolve(1);
          },
          complete: () => {
            const showNothingDone = !(options.showNothingDone === false);
            if (nothingDone && showNothingDone) {
              this.logger.info('Nothing to be done.');
            }
            if (dryRun) {
              this.logger.warn(`\nNOTE: The "dryRun" flag means no changes were made.`);
            }
            resolve();
          },
        });
    });
  }

  protected async parseFreeFormArguments(schematicOptions: string[]) {
    return parseFreeFormArguments(schematicOptions);
  }

  protected async parseArguments(
    schematicOptions: string[],
    options: Option[] | null,
  ): Promise<Arguments> {
    return parseArguments(schematicOptions, options, this.logger);
  }
}

function getProjectsByPath(
  workspace: workspaces.WorkspaceDefinition,
  path: string,
  root: string,
): string[] {
  if (workspace.projects.size === 1) {
    return Array.from(workspace.projects.keys());
  }

  const isInside = (base: string, potential: string): boolean => {
    const absoluteBase = systemPath.resolve(root, base);
    const absolutePotential = systemPath.resolve(root, potential);
    const relativePotential = systemPath.relative(absoluteBase, absolutePotential);
    if (!relativePotential.startsWith('..') && !systemPath.isAbsolute(relativePotential)) {
      return true;
    }

    return false;
  };

  const projects = Array.from(workspace.projects.entries())
    .map(([name, project]) => [systemPath.resolve(root, project.root), name] as [string, string])
    .filter(tuple => isInside(tuple[0], path))
    // Sort tuples by depth, with the deeper ones first. Since the first member is a path and
    // we filtered all invalid paths, the longest will be the deepest (and in case of equality
    // the sort is stable and the first declared project will win).
    .sort((a, b) => b[0].length - a[0].length);

  if (projects.length === 1) {
    return [projects[0][1]];
  } else if (projects.length > 1) {
    const firstPath = projects[0][0];

    return projects.filter(v => v[0] === firstPath).map(v => v[1]);
  }

  return [];
}
