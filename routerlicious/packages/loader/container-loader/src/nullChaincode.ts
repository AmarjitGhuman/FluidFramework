import {
    ConnectionState,
    IChaincodeFactory,
    IContainerContext,
    IRequest,
    IResponse,
    IRuntime,
    ISequencedDocumentMessage,
    ITree,
} from "@prague/container-definitions";

class NullRuntime implements IRuntime {
    public ready: Promise<void>;

    public snapshot(tagMessage: string): Promise<ITree> {
        return Promise.resolve(null);
    }

    public changeConnectionState(value: ConnectionState, clientId: string) {
        return;
    }

    public stop(): Promise<void> {
        return Promise.resolve();
    }

    public request(request: IRequest): Promise<IResponse> {
        return Promise.resolve({ status: 404, mimeType: "text/plain", value: null });
    }

    public prepare(message: ISequencedDocumentMessage, local: boolean): Promise<any> {
        return Promise.reject("Null chaincode should not receive messages");
    }

    public process(message: ISequencedDocumentMessage, local: boolean, context: any) {
        throw new Error("Null chaincode should not receive messages");
    }

    public postProcess(message: ISequencedDocumentMessage, local: boolean, context: any): Promise<void> {
        return Promise.reject("Null chaincode should not receive messages");
    }

    public processSignal(message: any, local: boolean) {
        // todo (mdaumi): We might want to buffer signals before transitioning.
        return Promise.reject("Null chaincode should not receive signals");
    }

    public updateMinSequenceNumber(minimumSequenceNumber: number) {
        return;
    }
}

export class NullChaincode implements IChaincodeFactory {
    public async instantiateRuntime(context: IContainerContext): Promise<IRuntime> {
        return new NullRuntime();
    }
}
