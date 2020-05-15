// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';

import * as serverStatic from 'serve-static';
import * as finalhandler from "finalhandler";

import * as vscode from 'vscode';
import { AddressInfo } from 'net';

import { ExcalidrawInstance } from './ExcalidrawInstance';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

function startServer(): http.Server {
	const root = path.resolve(__dirname, '../build');
	const serve = serverStatic(root);
	return http.createServer(function (req, res) {
		serve(req as any, res as any, finalhandler(req, res));
	});
}

function setupWebview(webview: vscode.Webview, port: number) {
	webview.options = {
		enableScripts: true,
	};
	webview.html = `<!DOCTYPE html><html>
	<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src * 'unsafe-inline'; img-src * data: blob: 'unsafe-inline'; frame-src *; style-src * 'unsafe-inline'; worker-src * data: 'unsafe-inline' 'unsafe-eval'; font-src * 'unsafe-inline' 'unsafe-eval';">
	<style>
		html { height: 100%; width: 100%; padding: 0; margin: 0; }
		body { height: 100%; width: 100%; padding: 0; margin: 0; }
		iframe { height: 100%; width: 100%; padding: 0; margin: 0; border: 0; display: block; }
	</style>
	</head>
	<body>
		<iframe src="http://localhost:${port}/index.html?embed=1"></iframe>
		<script>
			const api = window.VsCodeApi = acquireVsCodeApi();

			window.addEventListener('message', event => {
				if (event.source === window.frames[0]) {
					api.postMessage(event.data);
				} else {
					window.frames[0].postMessage(event.data, 'http://localhost:${port}');
				}
			});
		</script>
	</body>
	</html>`;
	return new ExcalidrawInstance({
		sendMessage: (msg) => webview.postMessage(msg),
		registerMessageHandler: (handler) => webview.onDidReceiveMessage(handler),
	});
}

class ExcalidrawEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
	server: http.Server;
	serverReady: Promise<void>;
	instances: { excalidrawInstance: ExcalidrawInstance, panel: vscode.WebviewPanel }[] = [];

	constructor(private context: vscode.ExtensionContext) {
		this.server = startServer();
		this.serverReady = new Promise(resolve => {
			this.server.listen(undefined, 'localhost', () => {
				resolve();
			});
		});
	}

	async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken) {
		let localDisposables: vscode.Disposable[] = [];
		let initialized = false;
		let firstChange = false;
		await this.serverReady;
		const excalidrawInstance = setupWebview(webviewPanel.webview, (this.server.address() as AddressInfo).port);
		let isEditorSaving = false;

		localDisposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document !== document || isEditorSaving || event.contentChanges.length === 0) {
				return;
			}

			excalidrawInstance.loadData(event.document.getText());
		}));

		localDisposables.push(excalidrawInstance.onChange(async (data) => {
			if (!firstChange) {
				firstChange = true;
				return;
			}

			if (!data || data.newData === document.getText()) {
				return;
			}

			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), data.newData);
			isEditorSaving = true;
			try {
				await vscode.workspace.applyEdit(edit);
			} finally {
				isEditorSaving = false;
			}
		}));

		localDisposables.push(
			excalidrawInstance.onSave(async () => {
				await document.save();
			})
		);
		webviewPanel.onDidDispose(() => {
			localDisposables.forEach(d => d.dispose());
			localDisposables = [];
			this.instances = this.instances.filter(i => i.panel !== webviewPanel);
		});

		excalidrawInstance.onInit(() => {
			if (initialized) {
				return;
			}
			initialized = true;
			excalidrawInstance.loadData(document.getText());
		});

		this.instances.push({
			excalidrawInstance,
			panel: webviewPanel,
		});
	}

	broadcastDelete() {
		this.instances.filter(i => i.panel.active).forEach(({ excalidrawInstance }) => {
			excalidrawInstance.deleteShape();
		});
	}

	public async exportTo(format: 'png' | 'svg' = 'png', scale = 1.0): Promise<string | null> {
		const instance = this.instances.find(i => i.panel.active);

		if (!instance) {
			return null;
		}

		const { excalidrawInstance } = instance;
		return await excalidrawInstance.exportTo(format, scale);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}

		this.instances = [];
	}
}

export async function activate(context: vscode.ExtensionContext) {
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	const provider = new ExcalidrawEditorProvider(context);
	context.subscriptions.push(vscode.window.registerCustomEditorProvider(
		'brijeshb42-excalidraw.texteditor',
		provider,
		{ webviewOptions: { retainContextWhenHidden: true } },
	));
	vscode.commands.registerCommand('brijeshb42-excalidraw.deleteshape', async () => {
		provider.broadcastDelete();
	});
	vscode.commands.registerCommand('brijeshb42-excalidraw.export', async () => {
		const result = await vscode.window.showQuickPick(['png', 'svg'], {
			placeHolder: 'Select the export format',
			ignoreFocusOut: false,
		});

		if (!result) {
			return;
		}

		let scale: string | number | undefined = 1;

		if (result === 'png') {
			scale = await vscode.window.showInputBox({
				value: '1',
				prompt: 'Input the scale of image (any number)',
				placeHolder: '1',
				ignoreFocusOut: false,
				validateInput(value) {
					if (!Number.isNaN(parseFloat(value))) {
						return null;
					}

					return 'error';
				},
			});
		}

		if (!scale) {
			return;
		}

		const data = await provider.exportTo(result as 'svg' | 'png', parseFloat(scale as string));

		if (!data) {
			vscode.window.showErrorMessage('Could not export.');
		} else {
			vscode.window.showSaveDialog({
				saveLabel: `Export as ${result}`,
			}).then(uri => {
				if (!uri) {
					return;
				}

				let modUri = uri.path;
				if (!modUri.endsWith(`.${result}`)) {
					modUri += `.${result}`;
				}

				if (result === 'png') {
					fs.writeFileSync(modUri, data.replace(/^data:image\/\w+;base64,/, ''), { encoding: 'base64' });
				} else {
					fs.writeFileSync(modUri, data);
				}
			});
		}
	});
	context.subscriptions.push(provider);
}