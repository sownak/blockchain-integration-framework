import path from 'path';
import { Server } from 'http';
import { Config } from 'convict';
import express, { Express, Request, Response, NextFunction, RequestHandler, Application } from 'express';
import { OpenApiValidator } from 'express-openapi-validator';
import compression from 'compression';
import bodyParser from 'body-parser';
import cors, { CorsOptions } from 'cors';
import { IPluginKVStorage, PluginFactory } from '@hyperledger-labs/bif-core-api';
import { CreateConsortiumEndpointV1 } from './consortium/routes/create-consortium-endpoint-v1';
import { IBifApiServerOptions, ConfigService } from './config/config-service';
import { BIF_OPEN_API_JSON } from './openapi-spec';
import { Logger, LoggerProvider } from '@hyperledger-labs/bif-common';

export interface IApiServerConstructorOptions {
  config: Config<IBifApiServerOptions>;
}

export class ApiServer {

  private readonly log: Logger;
  private httpServerApi: Server | null = null;
  private httpServerFile: Server | null = null;

  constructor(public readonly options: IApiServerConstructorOptions) {
    if (!options) {
      throw new Error(`ApiServer#ctor options was falsy`);
    }
    if (!options.config) {
      throw new Error(`ApiServer#ctor options.config was falsy`);
    }
    this.log = LoggerProvider.getOrCreate({ label: 'api-server', level: options.config.get('logLevel') });
  }

  async start(): Promise<void> {
    try {
      await this.startCockpitFileServer();
      await this.startApiServer();
    } catch (ex) {
      this.log.error(`Failed to start ApiServer: ${ex.stack}`);
      this.log.error(`Attempting shutdown...`);
      await this.shutdown();
    }
  }

  public shutdown(): Promise<any> {

    const apiServerShutdown = new Promise<void>((resolve, reject) => {
      if (this.httpServerApi) {
        this.httpServerApi.close((err: any) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });

    const fileServerShutdown = new Promise<void>((resolve, reject) => {
      if (this.httpServerFile) {
        this.httpServerFile.close((err: any) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });

    return Promise.all([apiServerShutdown, fileServerShutdown]);
  }

  async startCockpitFileServer(): Promise<void> {
    const cockpitWwwRoot = this.options.config.get('cockpitWwwRoot');
    this.log.info(`wwwRoot: ${cockpitWwwRoot}`);

    const resolvedWwwRoot = path.resolve(process.cwd(), cockpitWwwRoot);
    this.log.info(`resolvedWwwRoot: ${resolvedWwwRoot}`);

    const resolvedIndexHtml = path.resolve(resolvedWwwRoot + '/index.html');
    this.log.info(`resolvedIndexHtml: ${resolvedIndexHtml}`);

    const app: Express = express();
    app.use(compression());
    app.use(express.static(resolvedWwwRoot));
    app.get('/*', (_, res) => res.sendFile(resolvedIndexHtml));

    const cockpitPort: number = this.options.config.get('cockpitPort');
    const cockpitHost: string = this.options.config.get('cockpitHost');

    await new Promise<any>((resolve, reject) => {
      this.httpServerApi = app.listen(cockpitPort, cockpitHost, () => {
        // tslint:disable-next-line: no-console
        console.log(`BIF Cockpit UI reachable on port ${cockpitPort}`);
        resolve({ cockpitPort });
      });
      this.httpServerApi.on('error', (err: any) => reject(err));
    });
  }

  async startApiServer(): Promise<void> {
    const app: Application = express();
    app.use(compression());

    const corsMiddleware = this.createCorsMiddleware()
    app.use(corsMiddleware);

    app.use(bodyParser.json({ limit: '50mb' }));

    const openApiValidator = this.createOpenApiValidator();
    await openApiValidator.install(app);

    app.get('/healthcheck', (req: Request, res: Response, next: NextFunction) => {
      res.json({ 'success': true, timestamp: new Date() });
    });

    const storage: IPluginKVStorage = await this.createStoragePlugin();
    const configService = new ConfigService();
    const config = configService.getOrCreate();
    {
      const endpoint = new CreateConsortiumEndpointV1({ storage, config });
      app.post(endpoint.getPath(), endpoint.handleRequest.bind(endpoint));
    }

    // FIXME
    // app.get('/api/v1/consortium/:consortiumId', (req: Request, res: Response, next: NextFunction) => {
    //   res.json({ swagger: 'TODO' });
    // });

    const apiPort: number = this.options.config.get('apiPort');
    const apiHost: string = this.options.config.get('apiHost');
    this.log.info(`Binding Cactus API to port ${apiPort}...`);
    await new Promise<any>((resolve, reject) => {
      const httpServer = app.listen(apiPort, apiHost, () => {
        const address: any = httpServer.address();
        this.log.info(`Successfully bound API to port ${apiPort}`, { address });
        if (address && address.port) {
          resolve({ port: address.port });
        } else {
          resolve({ port: apiPort });
        }
      });
      httpServer.on('error', (err) => reject(err));
    });
  }

  createOpenApiValidator(): OpenApiValidator {
    return new OpenApiValidator({
      apiSpec: BIF_OPEN_API_JSON,
      validateRequests: true,
      validateResponses: false
    });
  }

  async createStoragePlugin(): Promise<IPluginKVStorage> {
    const storagePluginPackage = this.options.config.get('storagePluginPackage');
    const { PluginFactoryKVStorage } = await import(storagePluginPackage);
    const storagePluginOptionsJson = this.options.config.get('storagePluginOptionsJson');
    const storagePluginOptions = JSON.parse(storagePluginOptionsJson);
    const pluginFactory: PluginFactory<IPluginKVStorage, unknown> = new PluginFactoryKVStorage();
    const plugin = await pluginFactory.create(storagePluginOptions);
    return plugin;
  }

  createCorsMiddleware(): RequestHandler {
    const apiCorsDomainCsv = this.options.config.get('apiCorsDomainCsv');
    const allowedDomains = apiCorsDomainCsv.split(',');
    const allDomainsAllowed = allowedDomains.includes('*');

    const corsOptions: CorsOptions = {
      origin: (origin: string | undefined, callback) => {
        if (allDomainsAllowed || origin && allowedDomains.indexOf(origin) !== -1) {
          callback(null, true);
        } else {
          callback(new Error(`CORS not allowed for Origin "${origin}".`));
        }
      }
    }
    return cors(corsOptions);
  }
}
