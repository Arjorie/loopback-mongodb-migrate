import { MongoDBMigrateComponentBindings } from '../keys';
import * as fs from 'fs';
import * as path from 'path';
import debugFactory from 'debug';
import { promisify } from 'util';
import { spawn } from 'child_process';
import { repository } from '@loopback/repository';
import { BindingScope, inject, injectable } from '@loopback/core';
import { Migrations } from '../models';
import { MigrationRepository } from '../repositories';
import {
  Application,
  IMigrationService,
  MongoDbBackUpOptions,
  RepoKeyValuePair,
  RepositoryModules,
} from '../types';

const debug = debugFactory('loopback-mongodb-migrate:');
debug.enabled = true;

@injectable({ scope: BindingScope.TRANSIENT })
export class MigrationService implements IMigrationService {
  rawMigrationFolder = '/src/migrations';
  builtMigrationFolder = '/dist/migrations';
  migrationContent = `
// Put your imports here
import { RepositoryModules } from "loopback-mongodb-migrate";

/**
 * up - update/create/delete records or entire database
 */
export async function up(repository: RepositoryModules) {
  // TODO: write your database execution here
  // const data = await repository.MigrationsRepository.find();
  // console.log({data});
}

/**
 * down - reverts a migration
 */
export async function down(repository: RepositoryModules) {
  // TODO: write your database execution here

}
  `;
  rootDir = path.resolve('.');
  rawMigrationDir = path
    .join(this.rootDir, this.rawMigrationFolder)
    .normalize();
  builtMigrationDir = path
    .join(this.rootDir, this.builtMigrationFolder)
    .normalize();
  writeFile = promisify(fs.writeFile);
  readFile = promisify(fs.readFile);
  readDir = promisify(fs.readdir);

  constructor(
    @repository(MigrationRepository) public migrationRepo: MigrationRepository,
    @inject(MongoDBMigrateComponentBindings.MONGODB_BACKUP_OPTIONS)
    public backUpOptions: MongoDbBackUpOptions,
  ) { }

  /**
   * migrate - executes the migration process
   * @param args
   * - arguments to execute
   *
   * commands for executing migration actions:
   * - `npm run migrate create <filename>`
   *    creates a migration file inside folder /src/migrations with timestamp
   * - `npm run migrate up`
   *    executes all migration files up
   *  - `npm run migrate down`
   *    executes all migration files down
   * - `npm run migrate up test` add the keyword `test:true` to test your migration script.
   * **NOTE** that this will execute the migration and saves whatever you do to your database
   * **BUT** will **NOT** mark as migrated so it will be executed again on your next migration just make sure to create a down migration to revert your changes
   * - `npm run migrate up backup:true` add the keyword `backup:true` to backup database before migrating.
   */
  async migrate(
    args: string[],
    repositories: RepositoryModules | null = null,
  ): Promise<void> {
    const action: string | null = args[2] ? args[2] : null;
    const filename: string | null = args[3] ? `${args[3]}` : null;
    const isTest: boolean = args[3] === 'test'; // for testing purposes

    // create migration file
    if (action === 'create') {
      if (!filename) throw new Error('Filename is missing');
      await this.generateMigrationFile(filename);
    } else if (action === 'up' || action === 'down') {
      await this.executeMigration(action, repositories, filename ?? '', isTest);
    } else if (action === 'backup') {
      await this.executeMigration(action, repositories, '', false);
    } else {
      debug(
        'Command <create> Example: npm run migrate create <migration-name>',
      );
      debug('Command <up> Example: npm run migrate up');
      debug('Command <down> Example: npm run migrate down');
    }
  }

  /**
   * generateMigrationFile - generates a migration file
   * @param filename - filename of the file to generate
   */
  async generateMigrationFile(filename: string): Promise<void> {
    const { rawMigrationDir, migrationContent } = this;
    // generate migrations folder if does not exist
    if (!fs.existsSync(rawMigrationDir)) {
      fs.mkdirSync(rawMigrationDir, {});
      debug('Generated migrations folder');
    }
    const transformedName = filename.trim().toLowerCase().replace(/_/g, '-');
    const stringDate = this.appendTimestampToFilename(transformedName, `ts`);
    const migrationFilename = `${rawMigrationDir}/${stringDate}`;
    await this.writeFile(migrationFilename, migrationContent);
    debug(`Generated migration file ${migrationFilename}`);
  }

  /**
   * appendTimestampToFilename - appends a timestamp to the migration filename
   * @param filename - the filename of the migration file
   * @param extension - the extension of the migration file; default is `ts`
   * @returns string - the migration file with timestamp
   */
  appendTimestampToFilename(
    filename: string,
    extension: string | null = null,
  ): string {
    const transformedName = filename.trim().toLowerCase().replace(/_/g, '-');
    // generate migration file
    const d = new Date();
    const hr = d.getHours().toString().padStart(2, '0');
    const min = d.getMinutes().toString().padStart(2, '0');
    const sec = d.getSeconds().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const year = d.getFullYear();
    const stringDate = `${month}-${day}-${year}_${hr}${min}${sec}`;
    const filenameWithTimestamp = `${transformedName}_${stringDate}${extension !== null ? `.${extension}` : ''
      }`;
    return filenameWithTimestamp;
  }

  /**
   * sortFiles - sorts the migrations files inside the `/src/migrations/` folder
   * @param toMigrateFiles - array of migration files to sort
   */
  sortFiles(toMigrateFiles: string[] = []) {
    // sort files
    toMigrateFiles.sort((file1: string, file2: string) => {
      const file1Array = file1.split('_');
      const fileArray = file2.split('_');
      file1Array.shift();
      fileArray.shift();
      const file1Part = file1Array.join('_');
      const file2Part = fileArray.join('_');
      return file1Part === file2Part ? 0 : file1Part < file2Part ? -1 : 1;
    });
  }

  /**
   * backupMongoDb - back ups the mongodb database
   * @returns Promise<boolean>
   */
  async backupMongoDb(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const {
        DATASOURCE_URL = 'mongodb://127.0.0.1:27017/mongodbName?retryWrites=true&w=majority',
        DB_BACKUP_DIR = '../backup',
        ROOT_DIR = path.resolve('.'),
      } = this.backUpOptions;
      const pathForDbBackup = path.join(
        ROOT_DIR,
        `${DB_BACKUP_DIR}/${this.appendTimestampToFilename('db')}`,
      );
      debug(`Backing up database to: ${pathForDbBackup}`);
      const ls = spawn('sh', [
        '-c',
        `mongodump -o ${pathForDbBackup} --uri=${DATASOURCE_URL}`,
      ]);
      ls.on('error', (error: { message: string }) => {
        debug(`error: ${error.message}`);
        reject(error);
      });
      ls.on('close', (_code: number | string) => {
        debug('Finished backup');
        resolve(true);
      });
    });
  }

  /**
   * executeMigration - executes the migration
   * @param action - the action to implement
   * @param repositories - list of repositories that can be access inside migration files
   * @param filename - the filename of the file to execute its `down` migration
   * @param isTest - flag if just a test
   * @param doBackUp - flag for database backup execution
   */
  async executeMigration(
    action: string,
    repositories: RepositoryModules | null = null,
    filename = '',
    isTest = false,
  ): Promise<void> {
    // get all migration files
    const { rawMigrationDir } = this;
    const files = await this.readDir(rawMigrationDir);
    // get migrated files from database
    const migratedFilesFromDb = await this.migrationRepo.find({});
    const migratedFilenames: string[] = [];
    migratedFilesFromDb.map((migrationFile: Migrations) => {
      migratedFilenames.push(migrationFile?.filename);
    });

    // remove migrated files from all files
    const toMigrateFiles: string[] = files.filter(
      file => migratedFilenames.indexOf(file) === -1,
    );
    if (action === 'backup') {
      // do database backup
      await this.backupMongoDb();
    } else if (action === 'down') {
      // check for filename
      if (!filename || filename === '') return debug('Filename is missing');
      // check for filename if exists from database
      const filteredFiles = migratedFilenames.filter((file: string) => {
        return file.includes(filename);
      });
      if (filteredFiles.length === 0) {
        return debug(
          "You're trying to migrate down a file that is not yet migrated",
        );
      }
      // execute down migration
      for (const file of filteredFiles) {
        const fileToExecute = `${this.builtMigrationDir}/${file.replace(
          /(.ts)$/g,
          '',
        )}`;
        debug(`File to execute:`, fileToExecute);
        if (fs.existsSync(`${fileToExecute}.js`)) {
          const migrationActions = await import(fileToExecute);
          if (!migrationActions.down) {
            return debug('migration down function not found');
          }
          debug(`Migrating down ${file}`);
          // execute migration down
          await migrationActions.down(repositories);
          debug(`${file} migrated down successfully`);
        }
      }

      console.log({ migratedFilenames, filteredFiles });
    } else {
      if (toMigrateFiles.length === 0) {
        debug('No migrations to execute. Database is up to date');
      }
      // sort files
      this.sortFiles(toMigrateFiles);

      // execute per file
      for (const file of toMigrateFiles) {
        const migrationActions = await import(
          `${this.builtMigrationDir}/${file.replace(/(.ts)$/g, '')}`
        );
        if (!migrationActions.up) {
          return debug('migration up function not found');
        }
        debug(`Migrating up ${file}`);
        // execute migration up
        await migrationActions.up(repositories);
        if (!isTest) {
          // save to database
          await this.migrationRepo.create({
            filename: file,
            dateMigrated: new Date().toISOString(),
          });
        }
        debug(`${file} migrated successfully`);
      }
    }
    return;
  }

  /**
   * getRepositories - retrieves list of repository and converts it to usable repository in migration files
   * @param app - the project application
   * @param allRepositories - imported repositories using `import * as allRepositories from'./repositories'`
   * @returns RepositoryModules - list of repositories that can be used in migration
   */
  async getRepositories(
    app: Application,
    allRepositories: object,
  ): Promise<RepositoryModules> {
    const repositories: RepositoryModules = {};
    const repos = Object.entries(allRepositories as RepoKeyValuePair);
    for (const [key, value] of repos) {
      repositories[key] = await app.getRepository(value);
    }
    return repositories;
  }
}
