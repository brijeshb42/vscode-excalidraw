import { Disposable, EventEmitter } from "vscode";

export interface MessageStream {
    registerMessageHandler(handler: (message: any) => void): Disposable;
    sendMessage(message: any): void;
}

export interface ExcalidrawEvent {
    type: 'init' | 'autosave' | 'save' | 'export' | 'configure';
    data: string;
    actionId?: string;
}

export interface ExcalidrawAction {
    type: 'load' | 'save' | 'deleteShape' | 'export';
    data?: string;
    autosave?: 1 | 0;
    scale?: number,
}

export class ExcalidrawInstance implements Disposable {
    private disposables: Disposable[] = [];
    private readonly onInitEmitter = new EventEmitter<void>();
    public readonly onInit = this.onInitEmitter.event;
    private readonly onChangeEmitter = new EventEmitter<{ newData: string, oldData: string | undefined } | void>();
    public readonly onChange = this.onChangeEmitter.event;
    private readonly onSaveEmitter = new EventEmitter<string | void>();
    public readonly onSave = this.onSaveEmitter.event;

    private currentData: string | undefined = undefined;
    private currentActionId = 0;
    private responseHandlers = new Map<string, { resolve: (response: ExcalidrawEvent) => void, reject: Function }>();

    constructor(public readonly messageStream: MessageStream) {
        this.disposables.push(
            messageStream.registerMessageHandler((msg) => this.handleEvent(msg as ExcalidrawEvent))
        );
    }

    private async handleEvent(event: ExcalidrawEvent) {
        switch (event.type) {
            case 'init':
                this.onInitEmitter.fire();
                break;
            case 'autosave':
                const newData = event.data;
                const oldData = this.currentData;
                this.currentData = newData;
                this.onChangeEmitter.fire({
                    newData,
                    oldData,
                });
                break;
            case 'save':
                this.onSaveEmitter.fire();
                break;
            default:
                // console.log(event);
                break;
        }

        if ('actionId' in event && event.actionId) {
            const responseHandler = this.responseHandlers.get(event.actionId);
            this.responseHandlers.delete(event.actionId);
            if (responseHandler) {
                responseHandler.resolve(event);
            }
        }
    }

    private sendAction(action: ExcalidrawAction, expectResponse: boolean = false): Promise<ExcalidrawEvent> {
        return new Promise((resolve, reject) => {
            const actionId = `${this.currentActionId++}`;
            if (expectResponse) {
                this.responseHandlers.set(actionId, {
                    resolve: response => resolve(response),
                    reject,
                });
            }
            this.messageStream.sendMessage(JSON.stringify({
                ...action,
                actionId,
                source: 'vscode-excalidraw',
            }));

            if (!expectResponse) {
                resolve();
            }
        });
    }

    public loadData(data: string) {
        this.currentData = undefined;
        this.sendAction({
            type: 'load',
            data,
            autosave: 1,
        });
    }

    public async getData(type: 'raw' | 'svg' | 'png' = 'raw') {
        const message = await this.sendAction({
            type: 'save',
            data: type,
        }, true);
        return message.data;
    }

    public async deleteShape() {
        await this.sendAction({
            type: 'deleteShape',
        }, true);
    }

    public async exportTo(format: string, scale = 1) {
        const res = await this.sendAction({
            type: 'save',
            data: format,
            scale,
        }, true);

        return res.data;
    }

    dispose() {
        this.onInitEmitter.dispose();
        this.onChangeEmitter.dispose();
        this.onSaveEmitter.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}