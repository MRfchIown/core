import { Container, Contracts, Providers, Utils } from "@arkecosystem/core-kernel";
import { Identifiers } from "./ioc";
import { SnapshotBlockRepository, SnapshotRoundRepository, SnapshotTransactionRepository } from "./repositories";
import { Models, Repositories } from "@arkecosystem/core-database";
import { Blocks, Interfaces, Managers } from "@arkecosystem/crypto";

import zlib from "zlib";
import fs from "fs-extra";
import msgpack from "msgpack-lite";
import { Verifier } from "./transport/verifier";
import { Utils as SnapshotUtils } from "./utils";
import { ProgressDispatcher } from "./progress-dispatcher";
import { Meta, Options, Codec } from "./contracts";

@Container.injectable()
export class SnapshotDatabaseService implements Contracts.Snapshot.DatabaseService {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.PluginConfiguration)
    @Container.tagged("plugin", "@arkecosystem/core-snapshots")
    private readonly configuration!: Providers.PluginConfiguration;

    // @Container.inject(Container.Identifiers.DatabaseConnection)
    // private readonly connection!: Connection;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    @Container.inject(Identifiers.SnapshotUtils)
    private readonly utils!: SnapshotUtils;

    @Container.inject(Identifiers.SnapshotBlockRepository)
    private readonly snapshotBlockRepository!: SnapshotBlockRepository;

    @Container.inject(Identifiers.SnapshotRoundRepository)
    private readonly snapshotRoundRepository!: SnapshotRoundRepository;

    @Container.inject(Identifiers.SnapshotTransactionRepository)
    private readonly snapshotTransactionRepository!: SnapshotTransactionRepository;

    private codec: string = "default";

    private skipCompression: boolean = false;

    public init(codec: string | undefined, skipCompression: boolean | undefined): void {
        this.codec = codec || "default";
        this.skipCompression = skipCompression || false;
    }

    public async truncate(): Promise<void> {
        // this.logger.info("Running TRUNCATE method inside DatabaseService");
        //
        // this.logger.info(`Is database connected: ${this.connection.isConnected}`);

        this.logger.info(
            `Clearing:  ${await this.snapshotBlockRepository.count()} blocks,  ${await this.snapshotTransactionRepository.count()} transactions,  ${await this.snapshotRoundRepository.count()} rounds.`,
        );

        await this.snapshotTransactionRepository.clear();
        await this.snapshotRoundRepository.clear();
        await this.snapshotBlockRepository.delete({}); // Clear does't work on tables with relations
    }

    public async rollbackChain(roundInfo: Contracts.Shared.RoundInfo): Promise<Interfaces.IBlock> {
        const lastRemainingBlock = await this.getLastBlock();

        Utils.assert.defined<Models.Block>(lastRemainingBlock);

        this.logger.info(`Last block height is: ${lastRemainingBlock.height}`);


        await this.snapshotBlockRepository.rollbackChain(roundInfo);
        // try {
        //     await this.snapshotBlockRepository.rollbackChain(lastRemainingBlock);
        // } catch (error) {
        //     // logger.error(error);
        // }

        return this.getLastBlock();
    }

    public async getLastBlock(): Promise<Interfaces.IBlock> {
        let block: Interfaces.IBlockData | undefined = await this.snapshotBlockRepository.findLast();

        if (!block) {
            throw new Error("Cannot find last block")
        }

        const lastBlock: Interfaces.IBlock = Blocks.BlockFactory.fromData(block)!;

        return lastBlock;
    }



    public async dump(options: Options.DumpOptions): Promise<void> {
        let metaData = await this.prepareMetaData(options);

        this.utils.setSnapshot(metaData.folder);
        await this.utils.prepareDir();

        await Promise.all([
            this.dumpTable(options, "blocks",  metaData.blocks.count, "height", this.snapshotBlockRepository),
            this.dumpTable(options, "transactions", metaData.transactions.count,"timestamp", this.snapshotTransactionRepository),
            this.dumpTable(options, "rounds", metaData.rounds.count,"round", this.snapshotRoundRepository)
        ]);

        await this.utils.writeMetaData(metaData);
    }

    public async restore(meta: Meta.MetaData): Promise<void> {
        await this.truncate();

        await this.restoreTable("blocks", meta.blocks.count, this.snapshotBlockRepository);
        await Promise.all([
            this.restoreTable( "transactions", meta.transactions.count, this.snapshotTransactionRepository),
            this.restoreTable("rounds", meta.rounds.count, this.snapshotRoundRepository)
        ]);
    }

    public async verify(meta: Meta.MetaData): Promise<void> {
        await Promise.all([
            this.verifyTable("blocks", meta.blocks.count, Verifier.verifyBlock),
            this.verifyTable("transactions", meta.transactions.count, Verifier.verifyTransaction),
            this.verifyTable("rounds", meta.rounds.count, Verifier.verifyRound)
        ]).catch((err) => {
            throw err;
        });
    }

    private async prepareMetaData(options: Options.DumpOptions): Promise<Meta.MetaData> {
        const blocksCount = await this.snapshotBlockRepository.count();
        const startHeight = (await this.snapshotBlockRepository.findFirst())?.height;
        const endHeight = (await this.snapshotBlockRepository.findLast())?.height;

        return {
            blocks: {
                count: blocksCount,
                startHeight: startHeight!,
                endHeight: endHeight!
            },
            transactions: {
                count: await this.snapshotTransactionRepository.count(),
                startHeight: startHeight!,
                endHeight: endHeight!
            },
            rounds: {
                count: await this.snapshotRoundRepository.count(),
                startHeight: startHeight!,
                endHeight: endHeight!
            },
            folder: `${startHeight}-${endHeight}`,

            skipCompression: this.skipCompression,
            network: options.network,

            packageVersion: this.app.get<string>(Identifiers.SnapshotVersion),
            codec: this.codec
        };
    }

    private dumpTable<T>(options: Options.DumpOptions, table: string, count: number, orderBy: string, repository: Repositories.AbstractEntityRepository<T>): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            let progressDispatcher = this.app.get<ProgressDispatcher>(Identifiers.ProgressDispatcher);

            await progressDispatcher.start(table, count);

            let databaseStream = await repository
                .createQueryBuilder()
                .orderBy(orderBy, "ASC")
                .stream();

            let writeStream = this.getWriteStream(options, databaseStream, table);

            writeStream
                .on('close', () => {
                    progressDispatcher.end();
                    resolve();
                });

            // const errorHandler = (err: Error) => {
            //     reject(err);
            // };

            // snapshotWriteStream.on("error", errorHandler);
            // encodeStream.on("error", errorHandler);
            // databaseStream.on("error", errorHandler);

            databaseStream.on("data", () => { progressDispatcher.update() });
        });
    }

    private async restoreTable<T>(table: string, count: number, repository: Repositories.AbstractEntityRepository<T>): Promise<void> {
        let readStream = this.getReadStream(table);

        let progressDispatcher = this.app.get<ProgressDispatcher>(Identifiers.ProgressDispatcher);
        await progressDispatcher.start(table, count);

        let entities: any[] = [];
        const chunkSize = this.configuration.getOptional("chunkSize", 1000) as number;

        for await (const entity of readStream) {
            if (table === "blocks") {
                this.applyGenesisBlockFix(entity as unknown as Models.Block);
            }

            entities.push(entity);

            if (entities.length === chunkSize) {
                await this.saveValues(entities, repository);
                entities = [];
            }

            await progressDispatcher.update();
        }

        if (entities.length) {
            await this.saveValues(entities, repository);
        }

        await progressDispatcher.end();
    }

    private async verifyTable(table: string, count: number, verifyFunction: Function) {
        let readStream = this.getReadStream(table);

        let progressDispatcher = this.app.get<ProgressDispatcher>(Identifiers.ProgressDispatcher);
        await progressDispatcher.start(table, count);

        let previousEntity: any = undefined;
        for await (const entity of readStream) {
            await progressDispatcher.update();

            if (table === "blocks") {
                this.applyGenesisBlockFix(entity as unknown as Models.Block);
            }

            const isVerified = verifyFunction(entity, previousEntity);
            if (!isVerified) {
                // TODO: Throw error
                throw new Error();
            }

            previousEntity = entity;
        }

        await progressDispatcher.end();
    }

    private getWriteStream(options: Options.DumpOptions, databaseStream: NodeJS.ReadableStream, table: string): NodeJS.WritableStream {
        const snapshotWriteStream = fs.createWriteStream(`${this.utils.getSnapshotFolderPath()}${table}`, {});
        const encodeStream = msgpack.createEncodeStream({ codec: this.getCodec()[table] });
        const gzipStream = zlib.createGzip();

        let stream: NodeJS.ReadableStream = databaseStream;

        stream = stream.pipe(encodeStream);

        if (!options.skipCompression) {
            stream = stream.pipe(gzipStream);
        }

        return stream.pipe(snapshotWriteStream);
    }

    private getReadStream(table: string): NodeJS.ReadableStream {
        const readStream = fs.createReadStream(`${this.utils.getSnapshotFolderPath()}${table}`, {});
        const gunzipStream = zlib.createGunzip();
        const decodeStream = msgpack.createDecodeStream({ codec: this.getCodec()[table] });

        let stream: NodeJS.ReadableStream = readStream;

        if (!this.skipCompression) {
            stream = stream.pipe(gunzipStream);
        }

        return stream.pipe(decodeStream);
    }

    private getCodec(name?: string): Codec {
        return this.app.getTagged<Codec>(Identifiers.SnapshotCodec, "codec", this.codec);
    }

    private applyGenesisBlockFix(block: Models.Block): void {
        if (block.height === 1) {
            // let genesisBlock = this.app.get<any>(Container.Identifiers.StateStore).getGenesisBlock();
            // TODO: State store instead database should set genesisBlock
            let genesisBlock = Blocks.BlockFactory.fromJson(Managers.configManager.get("genesisBlock"))!;
            block.id = genesisBlock.data.id!;
        }
    }

    private async saveValues<T>(entites: any[], repository: Repositories.AbstractEntityRepository<T>) {
        await repository.save(entites);
    }

    public async test(options: any): Promise<void> {
        // console.log(Utils.BigNumber.make("4b7209fd92d85a923a6cc5a2191157befe4e5f033356afbc4e3a9f94ff414fb1").toString());
        // console.log(this.configuration.get("chunkSize"));
        // console.log(this.utils.getSnapshotFolderPath("testnet","1-222"));
        // console.log(options);

        // console.log(this.utils.getSnapshotFolderPath());

        // console.log(await this.snapshotBlockRepository.findLast());
        // console.log(Blocks.BlockFactory.fromJson(Managers.configManager.get("genesisBlock"))!);
        console.log(this.getCodec().name);
    }
}


