// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as path from 'path';
import * as http from 'http';

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
	disposables: vscode.Disposable[] = [];

	constructor(private context: vscode.ExtensionContext) {
		this.server = startServer();
		this.serverReady = new Promise(resolve => {
			this.server.listen(undefined, 'localhost', () => {
				resolve();
			});
		});
	}

	async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken) {
		let initialized = false;
		await this.serverReady;
		const excalidrawInstance = setupWebview(webviewPanel.webview, (this.server.address() as AddressInfo).port);
		let isEditorSaving = false;
		let loadData = true;

		this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document !== document || isEditorSaving || event.contentChanges.length === 0) {
				return;
			}

			if (!loadData) {
				loadData = true;
				return;
			}

			excalidrawInstance.loadData(event.document.getText());
		}));

		this.disposables.push(excalidrawInstance.onChange(async (data) => {
			if (!data) {
				return;
			}

			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), data.newData);
			isEditorSaving = true;
			await vscode.workspace.applyEdit(edit);
			isEditorSaving = false;
		}));

		this.disposables.push(
			excalidrawInstance.onSave(async () => {
				await document.save();
			})
		);
		webviewPanel.onDidDispose(() => {
			this.disposables.forEach(d => d.dispose());
			this.disposables = [];
		});

		excalidrawInstance.onInit(() => {
			if (initialized) {
				return;
			}
			initialized = true;
			excalidrawInstance.loadData(document.getText());
		});

		this.context.subscriptions.push(
			vscode.commands.registerCommand('brijeshb42-excalidraw.deleteshape', async() => {
				await excalidrawInstance.deleteShape();
			})
		);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}

		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
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
	context.subscriptions.push(provider);
}