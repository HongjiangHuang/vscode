/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as nls from 'vscode-nls';
const localize = nls.loadMessageBundle();

import {
	languages, ExtensionContext, IndentAction, Position, TextDocument, Range, CompletionItem, CompletionItemKind, SnippetString, workspace, extensions,
	Disposable, FormattingOptions, CancellationToken, ProviderResult, TextEdit, CompletionContext, CompletionList, SemanticTokensLegend,
	DocumentSemanticTokensProvider, DocumentRangeSemanticTokensProvider, SemanticTokens, window, commands
} from 'vscode';
import {
	LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, RequestType, TextDocumentPositionParams, DocumentRangeFormattingParams,
	DocumentRangeFormattingRequest, ProvideCompletionItemsSignature, TextDocumentIdentifier, RequestType0, Range as LspRange
} from 'vscode-languageclient';
import { EMPTY_ELEMENTS } from './htmlEmptyTagsShared';
import { activateTagClosing } from './tagClosing';
import TelemetryReporter from 'vscode-extension-telemetry';
import { getCustomDataPathsInAllWorkspaces, getCustomDataPathsFromAllExtensions } from './customData';

namespace TagCloseRequest {
	export const type: RequestType<TextDocumentPositionParams, string, any, any> = new RequestType('html/tag');
}
namespace OnTypeRenameRequest {
	export const type: RequestType<TextDocumentPositionParams, Range[] | null, any, any> = new RequestType('html/onTypeRename');
}

// experimental: semantic tokens
interface SemanticTokenParams {
	textDocument: TextDocumentIdentifier;
	ranges?: LspRange[];
}
namespace SemanticTokenRequest {
	export const type: RequestType<SemanticTokenParams, number[] | null, any, any> = new RequestType('html/semanticTokens');
}
namespace SemanticTokenLegendRequest {
	export const type: RequestType0<{ types: string[]; modifiers: string[] } | null, any, any> = new RequestType0('html/semanticTokenLegend');
}

namespace SettingIds {
	export const renameOnType = 'editor.renameOnType';
	export const formatEnable = 'html.format.enable';

}

interface IPackageInfo {
	name: string;
	version: string;
	aiKey: string;
	main: string;
}

let telemetryReporter: TelemetryReporter | null;


export function activate(context: ExtensionContext) {
	let toDispose = context.subscriptions;

	let clientPackageJSON = getPackageInfo(context);
	telemetryReporter = new TelemetryReporter(clientPackageJSON.name, clientPackageJSON.version, clientPackageJSON.aiKey);

	const serverMain = `./server/${clientPackageJSON.main.indexOf('/dist/') !== -1 ? 'dist' : 'out'}/htmlServerMain`;
	const serverModule = context.asAbsolutePath(serverMain);

	// The debug options for the server
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6045'] };

	// If the extension is launch in debug mode the debug server options are use
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	};

	let documentSelector = ['html', 'handlebars'];
	let embeddedLanguages = { css: true, javascript: true };

	let rangeFormatting: Disposable | undefined = undefined;

	let dataPaths = [
		...getCustomDataPathsInAllWorkspaces(workspace.workspaceFolders),
		...getCustomDataPathsFromAllExtensions()
	];

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		documentSelector,
		synchronize: {
			configurationSection: ['html', 'css', 'javascript'], // the settings to synchronize
		},
		initializationOptions: {
			embeddedLanguages,
			dataPaths,
			provideFormatter: false, // tell the server to not provide formatting capability and ignore the `html.format.enable` setting.
		},
		middleware: {
			// testing the replace / insert mode
			provideCompletionItem(document: TextDocument, position: Position, context: CompletionContext, token: CancellationToken, next: ProvideCompletionItemsSignature): ProviderResult<CompletionItem[] | CompletionList> {
				function updateRanges(item: CompletionItem) {
					const range = item.range;
					if (range instanceof Range && range.end.isAfter(position) && range.start.isBeforeOrEqual(position)) {
						item.range = { inserting: new Range(range.start, position), replacing: range };
					}
				}
				function updateProposals(r: CompletionItem[] | CompletionList | null | undefined): CompletionItem[] | CompletionList | null | undefined {
					if (r) {
						(Array.isArray(r) ? r : r.items).forEach(updateRanges);
					}
					return r;
				}
				const isThenable = <T>(obj: ProviderResult<T>): obj is Thenable<T> => obj && (<any>obj)['then'];

				const r = next(document, position, context, token);
				if (isThenable<CompletionItem[] | CompletionList | null | undefined>(r)) {
					return r.then(updateProposals);
				}
				return updateProposals(r);
			}
		}
	};

	// Create the language client and start the client.
	let client = new LanguageClient('html', localize('htmlserver.name', 'HTML Language Server'), serverOptions, clientOptions);
	client.registerProposedFeatures();

	let disposable = client.start();
	toDispose.push(disposable);
	client.onReady().then(() => {
		let tagRequestor = (document: TextDocument, position: Position) => {
			let param = client.code2ProtocolConverter.asTextDocumentPositionParams(document, position);
			return client.sendRequest(TagCloseRequest.type, param);
		};
		disposable = activateTagClosing(tagRequestor, { html: true, handlebars: true }, 'html.autoClosingTags');
		toDispose.push(disposable);

		disposable = client.onTelemetry(e => {
			if (telemetryReporter) {
				telemetryReporter.sendTelemetryEvent(e.key, e.data);
			}
		});
		toDispose.push(disposable);

		// manually register / deregister format provider based on the `html.format.enable` setting avoiding issues with late registration. See #71652.
		updateFormatterRegistration();
		toDispose.push({ dispose: () => rangeFormatting && rangeFormatting.dispose() });
		toDispose.push(workspace.onDidChangeConfiguration(e => e.affectsConfiguration(SettingIds.formatEnable) && updateFormatterRegistration()));

		client.sendRequest(SemanticTokenLegendRequest.type).then(legend => {
			if (legend) {
				const provider: DocumentSemanticTokensProvider & DocumentRangeSemanticTokensProvider = {
					provideDocumentSemanticTokens(doc) {
						const params: SemanticTokenParams = {
							textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(doc),
						};
						return client.sendRequest(SemanticTokenRequest.type, params).then(data => {
							return data && new SemanticTokens(new Uint32Array(data));
						});
					},
					provideDocumentRangeSemanticTokens(doc, range) {
						const params: SemanticTokenParams = {
							textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(doc),
							ranges: [client.code2ProtocolConverter.asRange(range)]
						};
						return client.sendRequest(SemanticTokenRequest.type, params).then(data => {
							return data && new SemanticTokens(new Uint32Array(data));
						});
					}
				};
				toDispose.push(languages.registerDocumentSemanticTokensProvider(documentSelector, provider, new SemanticTokensLegend(legend.types, legend.modifiers)));
			}
		});

		disposable = languages.registerOnTypeRenameProvider(documentSelector, {
			async provideOnTypeRenameRanges(document, position) {
				const param = client.code2ProtocolConverter.asTextDocumentPositionParams(document, position);
				const response = await client.sendRequest(OnTypeRenameRequest.type, param);

				return response || [];
			}
		});
		toDispose.push(disposable);

	});

	function updateFormatterRegistration() {
		const formatEnabled = workspace.getConfiguration().get(SettingIds.formatEnable);
		if (!formatEnabled && rangeFormatting) {
			rangeFormatting.dispose();
			rangeFormatting = undefined;
		} else if (formatEnabled && !rangeFormatting) {
			rangeFormatting = languages.registerDocumentRangeFormattingEditProvider(documentSelector, {
				provideDocumentRangeFormattingEdits(document: TextDocument, range: Range, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]> {
					let params: DocumentRangeFormattingParams = {
						textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document),
						range: client.code2ProtocolConverter.asRange(range),
						options: client.code2ProtocolConverter.asFormattingOptions(options)
					};
					return client.sendRequest(DocumentRangeFormattingRequest.type, params, token).then(
						client.protocol2CodeConverter.asTextEdits,
						(error) => {
							client.logFailedRequest(DocumentRangeFormattingRequest.type, error);
							return Promise.resolve([]);
						}
					);
				}
			});
		}
	}

	languages.setLanguageConfiguration('html', {
		indentationRules: {
			increaseIndentPattern: /<(?!\?|(?:area|base|br|col|frame|hr|html|img|input|link|meta|param)\b|[^>]*\/>)([-_\.A-Za-z0-9]+)(?=\s|>)\b[^>]*>(?!.*<\/\1>)|<!--(?!.*-->)|\{[^}"']*$/,
			decreaseIndentPattern: /^\s*(<\/(?!html)[-_\.A-Za-z0-9]+\b[^>]*>|-->|\})/
		},
		wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
		onEnterRules: [
			{
				beforeText: new RegExp(`<(?!(?:${EMPTY_ELEMENTS.join('|')}))([_:\\w][_:\\w-.\\d]*)([^/>]*(?!/)>)[^<]*$`, 'i'),
				afterText: /^<\/([_:\w][_:\w-.\d]*)\s*>/i,
				action: { indentAction: IndentAction.IndentOutdent }
			},
			{
				beforeText: new RegExp(`<(?!(?:${EMPTY_ELEMENTS.join('|')}))(\\w[\\w\\d]*)([^/>]*(?!/)>)[^<]*$`, 'i'),
				action: { indentAction: IndentAction.Indent }
			}
		],
	});

	languages.setLanguageConfiguration('handlebars', {
		wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
		onEnterRules: [
			{
				beforeText: new RegExp(`<(?!(?:${EMPTY_ELEMENTS.join('|')}))([_:\\w][_:\\w-.\\d]*)([^/>]*(?!/)>)[^<]*$`, 'i'),
				afterText: /^<\/([_:\w][_:\w-.\d]*)\s*>/i,
				action: { indentAction: IndentAction.IndentOutdent }
			},
			{
				beforeText: new RegExp(`<(?!(?:${EMPTY_ELEMENTS.join('|')}))(\\w[\\w\\d]*)([^/>]*(?!/)>)[^<]*$`, 'i'),
				action: { indentAction: IndentAction.Indent }
			}
		],
	});

	const regionCompletionRegExpr = /^(\s*)(<(!(-(-\s*(#\w*)?)?)?)?)?$/;
	const htmlSnippetCompletionRegExpr = /^(\s*)(<(h(t(m(l)?)?)?)?)?$/;
	languages.registerCompletionItemProvider(documentSelector, {
		provideCompletionItems(doc, pos) {
			const results: CompletionItem[] = [];
			let lineUntilPos = doc.getText(new Range(new Position(pos.line, 0), pos));
			let match = lineUntilPos.match(regionCompletionRegExpr);
			if (match) {
				let range = new Range(new Position(pos.line, match[1].length), pos);
				let beginProposal = new CompletionItem('#region', CompletionItemKind.Snippet);
				beginProposal.range = range;
				beginProposal.insertText = new SnippetString('<!-- #region $1-->');
				beginProposal.documentation = localize('folding.start', 'Folding Region Start');
				beginProposal.filterText = match[2];
				beginProposal.sortText = 'za';
				results.push(beginProposal);
				let endProposal = new CompletionItem('#endregion', CompletionItemKind.Snippet);
				endProposal.range = range;
				endProposal.insertText = new SnippetString('<!-- #endregion -->');
				endProposal.documentation = localize('folding.end', 'Folding Region End');
				endProposal.filterText = match[2];
				endProposal.sortText = 'zb';
				results.push(endProposal);
			}
			let match2 = lineUntilPos.match(htmlSnippetCompletionRegExpr);
			if (match2 && doc.getText(new Range(new Position(0, 0), pos)).match(htmlSnippetCompletionRegExpr)) {
				let range = new Range(new Position(pos.line, match2[1].length), pos);
				let snippetProposal = new CompletionItem('HTML sample', CompletionItemKind.Snippet);
				snippetProposal.range = range;
				const content = ['<!DOCTYPE html>',
					'<html>',
					'<head>',
					'\t<meta charset=\'utf-8\'>',
					'\t<meta http-equiv=\'X-UA-Compatible\' content=\'IE=edge\'>',
					'\t<title>${1:Page Title}</title>',
					'\t<meta name=\'viewport\' content=\'width=device-width, initial-scale=1\'>',
					'\t<link rel=\'stylesheet\' type=\'text/css\' media=\'screen\' href=\'${2:main.css}\'>',
					'\t<script src=\'${3:main.js}\'></script>',
					'</head>',
					'<body>',
					'\t$0',
					'</body>',
					'</html>'].join('\n');
				snippetProposal.insertText = new SnippetString(content);
				snippetProposal.documentation = localize('folding.html', 'Simple HTML5 starting point');
				snippetProposal.filterText = match2[2];
				snippetProposal.sortText = 'za';
				results.push(snippetProposal);
			}
			return results;
		}
	});

	const promptForTypeOnRenameKey = 'html.promptForTypeOnRename';
	const promptForTypeOnRename = extensions.getExtension('formulahendry.auto-rename-tag') !== undefined &&
		(context.globalState.get(promptForTypeOnRenameKey) !== false) &&
		!workspace.getConfiguration('editor', { languageId: 'html' }).get('renameOnType');

	if (promptForTypeOnRename) {
		const activeEditorListener = window.onDidChangeActiveTextEditor(async e => {
			if (e && documentSelector.indexOf(e.document.languageId) !== -1) {
				context.globalState.update(promptForTypeOnRenameKey, false);
				activeEditorListener.dispose();
				const configure = localize('configureButton', 'Configure');
				const res = await window.showInformationMessage(localize('renameOnTypeQuestion', 'VS Code now has built-in support for auto-renaming tags. Do you want to enable it?'), configure);
				if (res === configure) {
					commands.executeCommand('workbench.action.openSettings', SettingIds.renameOnType);
				}
			}
		});
		toDispose.push(activeEditorListener);
	}

	toDispose.push();
}

function getPackageInfo(context: ExtensionContext): IPackageInfo {
	const location = context.asAbsolutePath('./package.json');
	try {
		return JSON.parse(fs.readFileSync(location).toString());
	} catch (e) {
		console.log(`Problems reading ${location}: ${e}`);
		return { name: '', version: '', aiKey: '', main: '' };
	}
}

export function deactivate(): Promise<any> {
	return telemetryReporter ? telemetryReporter.dispose() : Promise.resolve(null);
}
