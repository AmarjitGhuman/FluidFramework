/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IConnectionDetails,
    IDeltaHandlerStrategy,
    IDeltaManager,
    IDeltaQueue,
    ITelemetryLogger,
} from "@microsoft/fluid-container-definitions";
import { Deferred, isSystemType, PerformanceEvent } from "@microsoft/fluid-core-utils";
import {
    Browser,
    ConnectionMode,
    IClient,
    IContentMessage,
    IDocumentDeltaStorageService,
    IDocumentMessage,
    IDocumentService,
    IDocumentSystemMessage,
    ISequencedDocumentMessage,
    IServiceConfiguration,
    ISignalMessage,
    ITrace,
    MessageType,
} from "@microsoft/fluid-protocol-definitions";
import * as assert from "assert";
import { EventEmitter } from "events";
import { ContentCache } from "./contentCache";
import { debug } from "./debug";
import { DeltaConnection } from "./deltaConnection";
import { DeltaQueue } from "./deltaQueue";
import { logNetworkFailure, waitForConnectedState } from "./networkUtils";
// tslint:disable-next-line:no-var-requires
const performanceNow = require("performance-now") as (() => number);

const MaxReconnectDelay = 8000;
const InitialReconnectDelay = 1000;
const MissingFetchDelay = 100;
const MaxFetchDelay = 10000;
const MaxBatchDeltas = 2000;
const DefaultChunkSize = 16 * 1024;

// This can be anything other than null
const ImmediateNoOpResponse = "";

const DefaultContentBufferSize = 10;

// Test if we deal with INetworkError / NetworkError object and if it has enough information to make a call.
// If in doubt, allow retries.
function canRetryOnError(error: any) {
    // Always retry unless told otherwise.
    // tslint:disable-next-line:no-unsafe-any
    return error === null || typeof error !== "object" || error.canRetry === undefined || error.canRetry;
}

enum retryFor {
    DELTASTREAM,
    DELTASTORAGE,
}

/**
 * Manages the flow of both inbound and outbound messages. This class ensures that shared objects receive delta
 * messages in order regardless of possible network conditions or timings causing out of order delivery.
 */
export class DeltaManager extends EventEmitter implements IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {
    public get disposed() { return this.isDisposed; }

    public readonly clientType: string;
    public get IDeltaSender() { return this; }

    // Current conneciton mode. Initially write.
    public connectionMode: ConnectionMode = "write";
    // Overwrites the current connection mode to always write.
    private readonly systemConnectionMode: ConnectionMode;

    private isDisposed: boolean = false;
    private pending: ISequencedDocumentMessage[] = [];
    private fetching = false;

    private inQuorum = false;

    // Flag indicating whether or not we need to update the reference sequence number
    private updateHasBeenRequested = false;
    private updateSequenceNumberTimer: any;

    // The minimum sequence number and last sequence number received from the server
    private minSequenceNumber: number = 0;

    // There are three numbers we track
    // * lastQueuedSequenceNumber is the last queued sequence number
    private lastQueuedSequenceNumber: number = 0;
    private baseSequenceNumber: number = 0;

    // the sequence number we initially loaded from
    private initSequenceNumber: number = 0;

    private readonly _inboundPending: DeltaQueue<ISequencedDocumentMessage>;
    private readonly _inbound: DeltaQueue<ISequencedDocumentMessage>;
    private readonly _inboundSignal: DeltaQueue<ISignalMessage>;
    private readonly _outbound: DeltaQueue<IDocumentMessage[]>;

    private connecting: Deferred<IConnectionDetails> | undefined;
    private connection: DeltaConnection | undefined;
    private clientSequenceNumber = 0;
    private clientSequenceNumberObserved = 0;
    private closed = false;

    private handler: IDeltaHandlerStrategy | undefined;
    private deltaStorageP: Promise<IDocumentDeltaStorageService> | undefined;

    private readonly contentCache = new ContentCache(DefaultContentBufferSize);

    private messageBuffer: IDocumentMessage[] = [];

    private pongCount: number = 0;
    private socketLatency = 0;

    private connectRepeatCount = 0;
    private connectStartTime = 0;
    private connectFirstConnection = true;

    private deltaStorageDelay: number | undefined;
    private deltaStreamDelay: number | undefined;

    // collab window tracking.
    // Start with 50 not to record anything below 50 (= 30 + 20).
    private collabWindowMax = 30;

    public get inbound(): IDeltaQueue<ISequencedDocumentMessage> {
        return this._inbound;
    }

    public get outbound(): IDeltaQueue<IDocumentMessage[]> {
        return this._outbound;
    }

    public get inboundSignal(): IDeltaQueue<ISignalMessage> {
        return this._inboundSignal;
    }

    public get initialSequenceNumber(): number {
        return this.initSequenceNumber;
    }

    public get referenceSequenceNumber(): number {
        return this.baseSequenceNumber;
    }

    public get minimumSequenceNumber(): number {
        return this.minSequenceNumber;
    }

    public get maxMessageSize(): number {
        return this.connection!.details.serviceConfiguration
            ? this.connection!.details.serviceConfiguration.maxMessageSize
            : this.connection!.details.maxMessageSize || DefaultChunkSize;
    }

    public get version(): string {
        return this.connection!.details.version;
    }

    public get serviceConfiguration(): IServiceConfiguration {
        return this.connection!.details.serviceConfiguration;
    }

    public get active(): boolean {
         return this.inQuorum && this.connectionMode === "write";
    }

    public get socketDocumentId(): string | undefined {
        if (this.connection) {
            return this.connection.details.claims.documentId;
        }
        return undefined;
   }

    constructor(
        private readonly service: IDocumentService,
        private readonly client: IClient | null,
        private readonly logger: ITelemetryLogger,
        private readonly reconnect: boolean) {
        super();

        this.clientType = (!this.client || !this.client.type) ? Browser : this.client.type;
        this.systemConnectionMode = (this.client && this.client.mode === "write") ? "write" : "read";

        // Inbound message queue
        this._inboundPending = new DeltaQueue<ISequencedDocumentMessage>(
            (op, callback) => {
                // Explicitly split the two cases to avoid the async call in the case we are not split
                if (op!.contents === undefined) {
                    this.fetchOpContent(op).then(
                        (opContents) => {
                            op.contents = opContents.contents;
                            this._inbound.push(op);
                            callback();
                        },
                        (error) => {
                            callback(error);
                        });
                } else {
                    this._inbound.push(op);
                    callback();
                }
            });

        this._inbound = new DeltaQueue<ISequencedDocumentMessage>(
            (op, callback) => {
                try {
                    this.processMessage(op, callback);
                } catch (error) {
                    callback(error);
                }
            });

        this._inboundPending.on("error", (error) => {
            this.emit("error", error);
        });

        this._inbound.on("error", (error) => {
            this.emit("error", error);
        });

        // Outbound message queue. The outbound queue is represented as a queue of an array of ops. Ops contained
        // within an array *must* fit within the maxMessageSize and are guaranteed to be ordered sequentially.
        this._outbound = new DeltaQueue<IDocumentMessage[]>(
            (messages, callback: (error?) => void) => {
                if (this.shouldSplit(messages)) {
                    messages.forEach((message) => {
                        debug(`Splitting content from envelope.`);
                        this.connection!.submitAsync([message]).then(
                            () => {
                                this.contentCache.set({
                                    clientId: this.connection!.details.clientId,
                                    clientSequenceNumber: message!.clientSequenceNumber,
                                    contents: message!.contents as string,
                                });
                                message!.contents = undefined;
                                this.connection!.submit([message]);
                                callback();
                            },
                            (error) => {
                                callback(error);
                            });
                    });
                } else {
                    this.connection!.submit(messages);
                    callback();
                }
            });

        this._outbound.on("error", (error) => {
            this.emit("error", error);
        });

        // Inbound signal queue
        this._inboundSignal = new DeltaQueue<ISignalMessage>((message, callback: (error?) => void) => {
            // tslint:disable no-unsafe-any
            message!.content = JSON.parse(message!.content);
            this.handler!.processSignal(message!);
            callback();
        });

        this._inboundSignal.on("error", (error) => {
            this.emit("error", error);
        });

        // Require the user to start the processing
        this._inbound.pause();
        this._outbound.pause();
        this._inboundSignal.pause();
    }

    public dispose() {
        assert.fail("Not implemented.");
        this.isDisposed = true;
    }

    /**
     * Sets the sequence number from which inbound messages should be returned
     */
    public attachOpHandler(
            minSequenceNumber: number,
            sequenceNumber: number,
            handler: IDeltaHandlerStrategy,
            resume: boolean) {
        debug("Attached op handler", sequenceNumber);

        this.initSequenceNumber = sequenceNumber;
        this.baseSequenceNumber = sequenceNumber;
        this.minSequenceNumber = minSequenceNumber;
        this.lastQueuedSequenceNumber = sequenceNumber;

        // we will use same check in other places to make sure all the seq number above are set properly.
        assert(!this.handler);
        this.handler = handler;
        assert(this.handler);

        // We are ready to process inbound messages
        if (resume) {
            this._inbound.systemResume();
            this._inboundSignal.systemResume();

            // If we have pending ops from web socket, then we can use that to start download
            // based on missing ops - catchUp() will do just that.
            // Otherwise proactively ask storage for ops
            if (this.pending.length > 0) {
                this.catchUp("DocumentOpen", []);
            } else {
                this.fetchMissingDeltas("DocumentOpen", sequenceNumber);
            }
        }
    }

    public updateQuorumJoin() {
        this.inQuorum = true;
    }

    public updateQuorumLeave() {
        this.inQuorum = false;
    }

    public async connect(reason: string): Promise<IConnectionDetails> {
        assert(!this.closed);

        if (this.connecting) {
            assert(!this.connection);
            return this.connecting.promise;
        }
        if (this.connection) {
            return this.connection.details;
        }

        this.connecting = new Deferred<IConnectionDetails>();
        this.connectCore(reason, InitialReconnectDelay, this.connectionMode);

        return this.connecting.promise;
    }

    public flush() {
        if (this.messageBuffer.length === 0) {
            return;
        }

        // The prepareFlush event allows listenerse to append metadata to the batch prior to submission.
        this.emit("prepareSend", this.messageBuffer);

        this._outbound.push(this.messageBuffer);
        this.messageBuffer = [];
    }

    public submit(type: MessageType, contents: any, batch = false, metadata?: any): number {
        // TODO need to fail if gets too large
        // const serializedContent = JSON.stringify(this.messageBuffer);
        // const maxOpSize = this.context.deltaManager.maxMessageSize;

        // Start adding trace for the op.
        const traces: ITrace[] = [
            {
                action: "start",
                service: this.clientType,
                timestamp: Date.now(),
            }];

        const message: IDocumentMessage = {
            clientSequenceNumber: ++this.clientSequenceNumber,
            contents: JSON.stringify(contents),
            metadata,
            referenceSequenceNumber: this.baseSequenceNumber,
            traces,
            type,
        };

        const outbound = this.createOutboundMessage(type, message);
        this.stopSequenceNumberUpdate();
        this.emit("submitOp", message);

        if (!batch) {
            this.flush();
            this.messageBuffer.push(outbound);
            this.flush();
        } else {
            this.messageBuffer.push(outbound);
        }

        return outbound.clientSequenceNumber;
    }

    public submitSignal(content: any) {
        if (this.connection) {
            this.connection.submitSignal(content);
        } else {
            this.logger.sendErrorEvent({eventName: "submitSignalDisconnected"});
        }
    }

    public async getDeltas(
            telemetryEventSuffix: string,
            fromInitial: number,
            to?: number): Promise<ISequencedDocumentMessage[]> {
        let retry: number = 0;
        let from: number = fromInitial;
        const allDeltas: ISequencedDocumentMessage[] = [];

        const telemetryEvent = PerformanceEvent.start(this.logger, {
            eventName: `GetDeltas_${telemetryEventSuffix}`,
            from,
            to,
        });

        let requests = 0;

        while (!this.closed) {
            const maxFetchTo = from + MaxBatchDeltas;
            const fetchTo = to === undefined ? maxFetchTo : Math.min(maxFetchTo, to);

            let deltasRetrievedLast = 0;
            let success = true;
            let canRetry = false;
            let retryAfter: number | undefined = 0;

            try {
                // Connect to the delta storage endpoint
                if (!this.deltaStorageP) {
                    this.deltaStorageP = this.service.connectToDeltaStorage();
                }

                const deltaStorage = await this.deltaStorageP!;

                requests++;

                // Grab a chunk of deltas - limit the number fetched to MaxBatchDeltas
                canRetry = true;
                const deltas = await deltaStorage.get(from, fetchTo);

                // Note that server (or driver code) can push here something unexpected, like undefined
                // Exception thrown as result of it will result in us retrying
                allDeltas.push(...deltas);

                deltasRetrievedLast = deltas.length;
                const lastFetch = deltasRetrievedLast > 0 ? deltas[deltasRetrievedLast - 1].sequenceNumber : from;

                // If we have no upper bound and fetched less than the max deltas - meaning we got as many as exit -
                // then we can resolve the promise. We also resolve if we fetched up to the expected to. Otherwise
                // we will look to try again
                // Note #1: we can get more ops than what we asked for - need to account for that!
                // Note #2: from & to are exclusive! I.e. we actually expect [from + 1, to - 1] range of ops back!
                // 1) to === undefined case: if last op  is below what we expect, then storage does not have
                //    any more, thus it's time to leave
                // 2) else case: if we got what we asked (to - 1) or more, then time to leave.
                if (to === undefined ? lastFetch < maxFetchTo - 1 : to - 1 <= lastFetch) {
                    telemetryEvent.end({ lastFetch, totalDeltas: allDeltas.length, requests });
                    return allDeltas;
                }

                // Attempt to fetch more deltas. If we didn't receive any in the previous call we up our retry
                // count since something prevented us from seeing those deltas
                from = lastFetch;
            } catch (error) {
                logNetworkFailure(
                    this.logger,
                    {
                        eventName: "GetDeltas_Error",
                        fetchTo,
                        from,
                        requests,
                        retry: retry + 1,
                    },
                    error);

                if (!canRetry || !canRetryOnError(error)) {
                    // It's game over scenario.
                    telemetryEvent.cancel({category: "error"}, error);
                    this.close(error);
                    return [];
                }
                success = false;
                retryAfter = this.backOffWaitTimeOnError(error);
            }

            let delay: number;
            if (deltasRetrievedLast !== 0) {
                delay = 0;
                retry = 0; // start calculating timeout over if we got some ops
            } else {
                retry++;
                delay = retryAfter !== undefined ?
                    retryAfter : Math.min(MaxFetchDelay, MissingFetchDelay * Math.pow(2, retry));
                this.emitDelayInfo(retryFor.DELTASTORAGE, delay);

                // Chances that we will get something from storage after that many retries is zero.
                // We wait 10 seconds between most of retries, so that's 16 minutes of waiting!
                // Note - it's very important that we differentiate connected state from possibly disconnected state!
                // Only bail out if we successfully connected to storage, but there were no ops
                // One (last) successful connection is sufficient, even if user was disconnected all prior attempts
                if (success && retry >= 100) {
                    telemetryEvent.cancel({
                        category: "error",
                        reason: "too many retries",
                        retry,
                        requests,
                        deltasRetrievedTotal: allDeltas.length,
                        replayFrom: from,
                        to });
                    this.close(new Error("Failed to retrieve ops from storage: giving up after too many retries"));
                    return [];
                }
            }

            telemetryEvent.reportProgress({
                delay,
                deltasRetrievedLast,
                deltasRetrievedTotal: allDeltas.length,
                replayFrom: from,
                requests,
                retry,
                success,
            });

            await waitForConnectedState(delay);
        }

        telemetryEvent.cancel({ reason: "container closed" });
        return [];
    }

    /**
     * Closes the connection and clears inbound & outbound queues.
     */
    public close(error?: any): void {
        if (this.closed) {
            return;
        }
        this.closed = true;

        // Note: "disconnect" & "nack" do not have error object
        if (error) {
            this.emit("error", error);
        }

        this.logger.sendTelemetryEvent({ eventName: "ContainerClose" }, error);

        this.stopSequenceNumberUpdate();

        if (this.connection) {
            this.connection.close();
            this.connection = undefined;
        }

        if (this.connecting) {
            this.connecting.reject(error !== undefined ? error : new Error("Container closed"));
            this.connecting = undefined;
        }

        this._inbound.clear();
        this._outbound.clear();
        this._inboundSignal.clear();

        this._inbound.systemPause();
        this._inboundSignal.systemPause();

        // Drop pending messages - this will ensure catchUp() does not go into infinite loop
        this.pending = [];

        this.removeAllListeners();

        this.emit("closed");
    }

    private recordPingTime(latency: number) {
        this.pongCount++;
        this.socketLatency += latency;
        const aggregateCount = 100;
        if (this.pongCount === aggregateCount) {
            this.logger.sendTelemetryEvent({eventName: "DeltaLatency", value: this.socketLatency / aggregateCount});
            this.pongCount = 0;
            this.socketLatency = 0;
        }
    }

    private shouldSplit(contents: IDocumentMessage[]): boolean {
        // Disabling message splitting - there is no compelling reason to use it.
        // Container.submitMessage should chunk messages properly.
        // Content can still be 2x size of maxMessageSize due to character escaping.
        const splitSize = this.maxMessageSize * 2;
        this.logger.debugAssert(
            !contents || contents.length <= splitSize,
            { eventName: "Splitting should not happen" });
        return false;
    }

    // Specific system level message attributes are need to be looked at by the server.
    // Hence they are separated and promoted as top level attributes.
    private createOutboundMessage(
        type: MessageType,
        coreMessage: IDocumentMessage): IDocumentMessage {
        if (isSystemType(type)) {
            const data = coreMessage.contents as string;
            coreMessage.contents = null;
            const outboundMessage: IDocumentSystemMessage = {
                ...coreMessage,
                data,
            };
            return outboundMessage;
        } else {
            return coreMessage;
        }
    }

    private emitDelayInfo(retryEndpoint: number, delay: number) {
        // delay === -1 means the corresponding endpoint has connected properly
        // and we do not need to emit any delay to app.
        if (retryEndpoint === retryFor.DELTASTORAGE) {
            this.deltaStorageDelay = delay;
        } else if (retryEndpoint === retryFor.DELTASTREAM) {
            this.deltaStreamDelay = delay;
        }
        if (this.deltaStreamDelay && this.deltaStorageDelay) {
            const delayTime = Math.max(this.deltaStorageDelay, this.deltaStreamDelay);
            if (delayTime >= 0) {
                this.emit("connectionDelay", delayTime);
            }
        }
    }

    private connectCore(reason: string, delay: number, mode: ConnectionMode): void {
        if (this.closed) {
            return;
        }
        if (this.connectRepeatCount === 0) {
            this.connectStartTime = performanceNow();
        }
        this.connectRepeatCount++;

        DeltaConnection.connect(
            this.service,
            this.client!,
            mode).then(
            (connection) => {
                this.connection = connection;

                // back-compat for newer clients and old server. If the server does not have mode, we reset to write.
                this.connectionMode = connection.details.mode ? connection.details.mode : "write";

                this.emitDelayInfo(retryFor.DELTASTREAM, -1);

                // If we retried more than once, log an event about how long it took
                if (this.connectRepeatCount > 1) {
                    this.logger.sendTelemetryEvent({
                            attempts: this.connectRepeatCount,
                            duration: (performanceNow() - this.connectStartTime).toFixed(0),
                            eventName: "MultipleDeltaConnectionFailures",
                        });
                }
                this.connectRepeatCount = 0;

                if (this.closed) {
                    // Raise proper events, Log telemetry event and close connection.
                    this.reconnectOnError(`Disconnect on close`, connection, this.systemConnectionMode);
                    assert(!connection.connected); // check we indeed closed it!
                    return;
                }

                this._outbound.systemResume();

                this.clientSequenceNumber = 0;
                this.clientSequenceNumberObserved = 0;

                // If first connection resolve the promise with the details
                if (this.connecting) {
                    this.connecting.resolve(connection.details);
                    this.connecting = undefined;
                }

                connection.on("op", (documentId: string, messages: ISequencedDocumentMessage[]) => {
                    if (messages instanceof Array) {
                        this.enqueueMessages(messages);
                    } else {
                        this.enqueueMessages([messages]);
                    }
                });

                connection.on("op-content", (message: IContentMessage) => {
                    this.contentCache.set(message);
                });

                connection.on("signal", (message: ISignalMessage) => {
                    this._inboundSignal.push(message);
                });

                // Always connect in write mode after getting nacked.
                connection.on("nack", (target: number) => {
                    const nackReason = target === -1 ? "Reconnecting to start writing" : "Reconnecting on nack";
                    this.reconnectOnError(nackReason, connection, "write");
                });

                //  Connection mode is always read on disconnect/error unless the system mode was write.
                connection.on("disconnect", (disconnectReason) => {
                    // Note: we might get multiple disconnect calls on same socket, as early disconnect notification
                    // ("server_disconnect", ODSP-specific) is mapped to "disconnect"
                    this.reconnectOnError(
                        `Reconnecting on disconnect: ${disconnectReason}`,
                        connection,
                        this.systemConnectionMode,
                        disconnectReason);
                });

                connection.on("error", (error) => {
                    // Observation based on early pre-production telemetry:
                    // We are getting transport errors from WebSocket here, right before or after "disconnect".
                    // This happens only in Firefox.
                    logNetworkFailure(this.logger, {eventName: "DeltaConnectionError"}, error);
                    this.reconnectOnError("Reconnecting on error", connection, this.systemConnectionMode, error);
                });

                connection.on("pong", (latency: number) => {
                    this.recordPingTime(latency);
                    this.emit("pong", latency);
                });

                // Notify of the connection
                // WARNING: This has to happen before processInitialMessages() call below.
                // If not, we may not update Container.pendingClientId in time before seeing our own join session op.
                this.emit("connect", connection.details);

                this.processInitialMessages(
                    connection.details.initialMessages,
                    connection.details.initialContents,
                    connection.details.initialSignals,
                    this.connectFirstConnection);
                this.connectFirstConnection = false;

            },
            (error) => {
                // Socket.io error when we connect to wrong socket, or hit some multiplexing bug
                if (!canRetryOnError(error)) {
                    this.close(error);
                    return;
                }

                // Log error once - we get too many errors in logs when we are offline,
                // and unfortunately there is no reliable way to detect that.
                if (this.connectRepeatCount === 1) {
                    logNetworkFailure(
                        this.logger,
                        {
                            delay,
                            eventName: "DeltaConnectionFailureToConnect",
                        },
                        error);
                }

                let delayNext = this.backOffWaitTimeOnError(error);
                if (delayNext === undefined) {
                    delayNext = Math.min(delay * 2, MaxReconnectDelay);
                }
                this.emitDelayInfo(retryFor.DELTASTREAM, delayNext);
                waitForConnectedState(delayNext).then(() => this.connectCore(reason, delayNext!, mode));
            });
    }

    private reconnectOnError(reason: string, connection: DeltaConnection, mode: ConnectionMode, error?: any) {
        // we quite often get protocol errors before / after observing nack/disconnect
        // we do not want to run through same sequence twice.
        if (connection !== this.connection) {
            return;
        }

        // avoid any re-entrancy - clear object reference
        this.connection = undefined;
        this.connectionMode = "read";

        this._outbound.systemPause();
        this._outbound.clear();
        this.emit("disconnect", reason);

        connection.close();

        // Reconnection is only enabled for browser clients.
        if (this.clientType !== Browser || !this.reconnect || this.closed || !canRetryOnError(error)) {
            this.close(error);
        } else {
            this.logger.sendTelemetryEvent({ eventName: "DeltaConnectionReconnect", reason }, error);
            const delayNext = this.backOffWaitTimeOnError(error);
            if (delayNext !== undefined) {
                this.emitDelayInfo(retryFor.DELTASTREAM, delayNext);
                waitForConnectedState(delayNext).then(() => this.connectCore(reason, InitialReconnectDelay, mode));
            } else {
                this.connectCore(reason, InitialReconnectDelay, mode);
            }
        }
    }

    private backOffWaitTimeOnError(error: any): number | undefined {
        let waitTime;
        if (error !== null && typeof error === "object" && error.retryAfterSeconds !== undefined) {
            waitTime = error.retryAfterSeconds;
        }
        return waitTime;
    }

    private processInitialMessages(
            messages: ISequencedDocumentMessage[] | undefined,
            contents: IContentMessage[] | undefined,
            signals: ISignalMessage[] | undefined,
            firstConnection: boolean): void {
        this.enqueInitialOps(messages, contents, firstConnection);
        this.enqueInitalSignals(signals);
    }

    private enqueInitialOps(
            messages: ISequencedDocumentMessage[] | undefined,
            contents: IContentMessage[] | undefined,
            firstConnection: boolean): void {
        if (contents && contents.length > 0) {
            for (const content of contents) {
                this.contentCache.set(content);
            }
        }
        if (messages && messages.length > 0) {
            this.catchUp(firstConnection ? "InitialOps" : "ReconnectOps", messages);
        }
    }

    private enqueInitalSignals(signals: ISignalMessage[] | undefined): void {
        if (signals && signals.length > 0) {
            for (const signal of signals) {
                this._inboundSignal.push(signal);
            }
        }
    }

    private async fetchOpContent(op: ISequencedDocumentMessage): Promise<IContentMessage> {
        let result: IContentMessage;
        const opContent = this.contentCache.peek(op.clientId);

        if (!opContent || opContent.clientSequenceNumber > op.clientSequenceNumber) {
            result = await this.waitForContent(op.clientId, op.clientSequenceNumber, op.sequenceNumber);
        } else if (opContent.clientSequenceNumber < op.clientSequenceNumber) {
            let nextContent = this.contentCache.get(op.clientId);
            while (nextContent && nextContent.clientSequenceNumber < op.clientSequenceNumber) {
                nextContent = this.contentCache.get(op.clientId);
            }

            assert(nextContent, "No content found");
            assert.equal(op.clientSequenceNumber, nextContent!.clientSequenceNumber, "Invalid op content order");

            result = nextContent!;
        } else {
            result = this.contentCache.get(op.clientId)!;
        }

        return result;
    }

    private enqueueMessages(
            messages: ISequencedDocumentMessage[],
            telemetryEventSuffix: string = "OutOfOrderMessage"): void {
        if (!this.handler) {
            // We did not setup handler yet.
            // This happens when we connect to web socket faster than we get attributes for container
            // and thus faster than attachOpHandler() is called
            // this.baseSequenceNumber is still zero, so we can't rely on this.fetchMissingDeltas()
            // to do the right thing.
            this.pending = this.pending.concat(messages);
            return;
        }

        let duplicateStart: number | undefined;
        let duplicateEnd: number | undefined;
        let duplicateCount = 0;

        for (const message of messages) {
            // Check that the messages are arriving in the expected order
            if (message.sequenceNumber <= this.lastQueuedSequenceNumber) {
                duplicateCount++;
                if (duplicateStart === undefined || duplicateStart > message.sequenceNumber) {
                    duplicateStart = message.sequenceNumber;
                }
                if (duplicateEnd === undefined || duplicateEnd < message.sequenceNumber) {
                    duplicateEnd = message.sequenceNumber;
                }
            } else if (message.sequenceNumber !== this.lastQueuedSequenceNumber + 1) {
                this.pending.push(message);
                this.fetchMissingDeltas(telemetryEventSuffix, this.lastQueuedSequenceNumber, message.sequenceNumber);
            } else {
                this.lastQueuedSequenceNumber = message.sequenceNumber;
                this._inbound.push(message);
            }
        }

        if (duplicateCount !== 0) {
            this.logger.sendTelemetryEvent({
                eventName: `DuplicateMessages_${telemetryEventSuffix}`,
                start: duplicateStart,
                end: duplicateEnd,
                count: duplicateCount,
            });
        }
    }

    private processMessage(message: ISequencedDocumentMessage, callback: (err?: any) => void): void {
        const startTime = Date.now();

        if (this.connection && this.connection.details.clientId === message.clientId) {
            const clientSequenceNumber = message.clientSequenceNumber;

            this.logger.debugAssert(this.clientSequenceNumberObserved <= clientSequenceNumber);
            this.logger.debugAssert(clientSequenceNumber <= this.clientSequenceNumber);

            this.clientSequenceNumberObserved = clientSequenceNumber;
            if (clientSequenceNumber === this.clientSequenceNumber) {
                this.emit("allSentOpsAckd");
            }
        }

        // TODO Remove after SPO picks up the latest build.
        if (message.contents && typeof message.contents === "string" && message.type !== MessageType.ClientLeave) {
            message.contents = JSON.parse(message.contents);
        }

        // Add final ack trace.
        if (message.traces && message.traces.length > 0) {
            message.traces.push({
                action: "end",
                service: this.clientType,
                timestamp: Date.now(),
            });
        }

        // Watch the minimum sequence number and be ready to update as needed
        assert(this.minSequenceNumber <= message.minimumSequenceNumber);
        this.minSequenceNumber = message.minimumSequenceNumber;

        assert.equal(message.sequenceNumber, this.baseSequenceNumber + 1);
        this.baseSequenceNumber = message.sequenceNumber;

        // record collab window max size, in 20 increments.
        const msnDistance = this.baseSequenceNumber - this.minSequenceNumber;
        if (this.collabWindowMax + 20 < msnDistance) {
            this.collabWindowMax = msnDistance;
            this.logger.sendTelemetryEvent({ eventName: "MSNWindow", value: msnDistance });
        }

        this.handler!.process(
            message,
            (err?: any) => {
                if (err) {
                    callback(err);
                } else {
                    // We will queue a message to update our reference sequence number upon receiving a server
                    // operation. This allows the server to know our true reference sequence number and be able to
                    // correctly update the minimum sequence number (MSN). We don't acknowledge other message types
                    // similarly (like a min sequence number update) to avoid acknowledgement cycles (i.e. ack the MSN
                    // update, which updates the MSN, then ack the update, etc...).
                    if (message.type === MessageType.Operation ||
                      message.type === MessageType.Propose) {
                      this.updateSequenceNumber(message.type);
                    }

                    const endTime = Date.now();
                    this.emit("processTime", endTime - startTime);

                    callback();
                }
            });
    }

    /**
     * Retrieves the missing deltas between the given sequence numbers
     */
    private fetchMissingDeltas(telemetryEventSuffix: string, from: number, to?: number) {
        // Exit out early if we're already fetching deltas
        if (this.fetching) {
            return;
        }

        if (this.closed) {
            this.logger.sendTelemetryEvent({eventName: "fetchMissingDeltasClosedConnection" });
            return [];
        }

        this.fetching = true;

        this.getDeltas(telemetryEventSuffix, from, to).then(
            (messages) => {
                this.emitDelayInfo(retryFor.DELTASTORAGE, -1);
                this.fetching = false;
                this.emit("caughtUp");
                this.catchUp(telemetryEventSuffix, messages);
            });
    }

    private async waitForContent(
            clientId: string,
            clientSeqNumber: number,
            seqNumber: number,
    ): Promise<IContentMessage> {
        const lateContentHandler = (clId: string) => {
            if (clientId === clId) {
                const lateContent = this.contentCache.peek(clId);
                if (lateContent && lateContent.clientSequenceNumber === clientSeqNumber) {
                    this.contentCache.removeListener("content", lateContentHandler);
                    debug(`Late content fetched from buffer ${clientId}: ${clientSeqNumber}`);
                    return this.contentCache.get(clientId);
                }
            }
        };

        this.contentCache.on("content", lateContentHandler);
        const content = await this.fetchContent(clientId, clientSeqNumber, seqNumber);
        this.contentCache.removeListener("content", lateContentHandler);

        return content;
    }

    private async fetchContent(
            clientId: string,
            clientSeqNumber: number,
            seqNumber: number): Promise<IContentMessage> {
        const messages = await this.getDeltas("fetchContent", seqNumber, seqNumber);
        this.emitDelayInfo(retryFor.DELTASTORAGE, -1);
        assert.ok(messages.length > 0, "Content not found in DB");

        const message = messages[0];
        assert.equal(message.clientId, clientId, "Invalid fetched content");
        assert.equal(message.clientSequenceNumber, clientSeqNumber, "Invalid fetched content");

        debug(`Late content fetched from DB ${clientId}: ${clientSeqNumber}`);
        return {
            clientId: message.clientId,
            clientSequenceNumber: message.clientSequenceNumber,
            contents: message.contents,
        };
    }

    private catchUp(telemetryEventSuffix: string, messages: ISequencedDocumentMessage[]): void {
        const props: any = {
            eventName: `CatchUp_${telemetryEventSuffix}`,
            messageCount: messages.length,
            pendingCount: this.pending.length,
        };
        if (messages.length !== 0) {
            props.from = messages[0].sequenceNumber;
            props.to = messages[messages.length - 1].sequenceNumber;
            props.messageGap = this.handler ? props.from - this.lastQueuedSequenceNumber - 1 : undefined;
        }
        this.logger.sendPerformanceEvent(props);

        // Apply current operations
        this.enqueueMessages(messages, telemetryEventSuffix);

        // Then sort pending operations and attempt to apply them again.
        // This could be optimized to stop handling messages once we realize we need to fetch missing values.
        // But for simplicity, and because catching up should be rare, we just process all of them.
        // Optimize for case of no handler - we put ops back into this.pending in such case
        if (this.handler) {
            const pendingSorted = this.pending.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
            this.pending = [];
            this.enqueueMessages(pendingSorted, telemetryEventSuffix);
        }
    }

    /**
     * Acks the server to update the reference sequence number
     */
    private updateSequenceNumber(type: MessageType): void {
        // Exit early for inactive clients. They don't take part in the minimum sequence number calculation.
        if (!this.active) {
            return;
        }

        // On a quorum proposal, immediately send a response to expedite the approval.
        if (type === MessageType.Propose) {
            this.submit(MessageType.NoOp, ImmediateNoOpResponse);
            return;
        }

        // If an update has already been requested then mark this fact. We will wait until no updates have
        // been requested before sending the updated sequence number.
        if (this.updateSequenceNumberTimer) {
            this.updateHasBeenRequested = true;
            return;
        }

        // Clear an update in 100 ms
        this.updateSequenceNumberTimer = setTimeout(() => {
            this.updateSequenceNumberTimer = undefined;

            // If a second update wasn't requested then send an update message. Otherwise defer this until we
            // stop processing new messages.
            if (!this.updateHasBeenRequested) {
                this.submit(MessageType.NoOp, null);
            } else {
                this.updateHasBeenRequested = false;
                this.updateSequenceNumber(type);
            }
        }, 100);
    }

    private stopSequenceNumberUpdate(): void {
        if (this.updateSequenceNumberTimer) {
            clearTimeout(this.updateSequenceNumberTimer);
        }

        this.updateHasBeenRequested = false;
        this.updateSequenceNumberTimer = undefined;
    }
}
