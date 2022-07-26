/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {isNgLanguageService, NgLanguageService, PluginConfig} from '@angular/language-service/api';
import * as ts from 'typescript/lib/tsserverlibrary';
import {promisify} from 'util';
import * as lsp from 'vscode-languageserver/node';
import * as htmlLs from 'vscode-html-languageservice';
import * as pugLs from '@volar/pug-language-service';

import {ServerOptions} from '../common/initialize';
import {NgccProgressEnd, OpenOutputChannel, ProjectLanguageService, ProjectLoadingFinish, ProjectLoadingStart, SuggestStrictMode} from '../common/notifications';
import {GetComponentsWithTemplateFile, GetTcbParams, GetTcbRequest, GetTcbResponse, GetTemplateLocationForComponent, GetTemplateLocationForComponentParams, IsInAngularProject, IsInAngularProjectParams, RunNgccParams, RunNgccRequest} from '../common/requests';

import {getHtmlCompletions, getPugCompletions, readNgCompletionData, tsCompletionEntryToLspCompletionItem} from './completion';
import {resolveAndRunNgcc} from './ngcc';
import {ServerHost} from './server_host';
import * as utils from './utils/utils';
import {pugDiagnosticToLspDiagnostic, tsDiagnosticToLspDiagnostic} from './diagnostic';
const SourceMap = require("@volar/source-map");


export interface SessionOptions {
  host: ServerHost;
  logger: ts.server.Logger;
  ngPlugin: string;
  resolvedNgLsPath: string;
  ivy: boolean;
  disableAutomaticNgcc: boolean;
  logToConsole: boolean;
  includeAutomaticOptionalChainCompletions: boolean;
  includeCompletionsWithSnippetText: boolean;
  forceStrictTemplates: boolean;
}

enum LanguageId {
  TS = 'typescript',
  HTML = 'html',
}

// Empty definition range for files without `scriptInfo`
const EMPTY_RANGE = lsp.Range.create(0, 0, 0, 0);
const setImmediateP = promisify(setImmediate);

enum NgccErrorMessageAction {
  showOutput,
}

/**
 * Session is a wrapper around lsp.IConnection, with all the necessary protocol
 * handlers installed for Angular language service.
 */
export class Session {
  private readonly connection: lsp.Connection;
  private readonly projectService: ts.server.ProjectService;
  private readonly logger: ts.server.Logger;
  private readonly ivy: boolean;
  private readonly disableAutomaticNgcc: boolean;
  private readonly configuredProjToExternalProj = new Map<string, string>();
  private readonly logToConsole: boolean;
  private readonly openFiles = new utils.MruTracker();
  private readonly includeAutomaticOptionalChainCompletions: boolean;
  private readonly includeCompletionsWithSnippetText: boolean;
  private snippetSupport: boolean|undefined;
  // Tracks the spawn order and status of the `ngcc` processes. This allows us to ensure we enable
  // the LS in the same order the projects were created in.
  private projectNgccQueue: Array<{project: ts.server.Project, done: boolean}> = [];
  private diagnosticsTimeout: NodeJS.Timeout|null = null;
  private isProjectLoading = false;
  /**
   * Tracks which `ts.server.Project`s have the renaming capability disabled.
   *
   * If we detect the compiler options diagnostic that suggests enabling strict mode, we want to
   * disable renaming because we know that there are many cases where it will not work correctly.
   */
  private renameDisabledProjects: WeakSet<ts.server.Project> = new WeakSet();
  private clientCapabilities: lsp.ClientCapabilities = {};

  private pugLs: pugLs.LanguageService;

  constructor(options: SessionOptions) {
    this.includeAutomaticOptionalChainCompletions =
        options.includeAutomaticOptionalChainCompletions;
    this.includeCompletionsWithSnippetText = options.includeCompletionsWithSnippetText;
    this.logger = options.logger;
    this.ivy = options.ivy;
    this.disableAutomaticNgcc = options.disableAutomaticNgcc;
    this.logToConsole = options.logToConsole;
    // Create a connection for the server. The connection uses Node's IPC as a transport.
    this.connection = lsp.createConnection({
      // cancelUndispatched is a "middleware" to handle all cancellation requests.
      // LSP spec requires every request to send a response back, even if it is
      // cancelled. See
      // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#cancelRequest
      cancelUndispatched(message: lsp.Message): lsp.ResponseMessage | undefined {
        return {
          jsonrpc: message.jsonrpc,
          // This ID is just a placeholder to satisfy the ResponseMessage type.
          // `vscode-jsonrpc` will replace the ID with the ID of the message to
          // be cancelled. See
          // https://github.com/microsoft/vscode-languageserver-node/blob/193f06bf602ee1120afda8f0bac33c5161cab18e/jsonrpc/src/common/connection.ts#L619
          id: -1,
          error: new lsp.ResponseError(lsp.LSPErrorCodes.RequestCancelled, 'Request cancelled'),
        };
      },
    });

    this.addProtocolHandlers(this.connection);
    this.projectService = this.createProjectService(options);

    this.pugLs = pugLs.getLanguageService(htmlLs.getLanguageService())
  }

  private createProjectService(options: SessionOptions): ts.server.ProjectService {
    const projSvc = new ts.server.ProjectService({
      host: options.host,
      logger: options.logger,
      cancellationToken: ts.server.nullCancellationToken,
      useSingleInferredProject: true,
      useInferredProjectPerProjectRoot: true,
      typingsInstaller: ts.server.nullTypingsInstaller,
      // Not supressing diagnostic events can cause a type error to be thrown when the
      // language server session gets an event for a file that is outside the project
      // managed by the project service, and for which a program does not exist in the
      // corresponding project's language service.
      // See https://github.com/angular/vscode-ng-language-service/issues/693
      suppressDiagnosticEvents: true,
      eventHandler: (e) => this.handleProjectServiceEvent(e),
      globalPlugins: [options.ngPlugin],
      pluginProbeLocations: [options.resolvedNgLsPath],
      // do not resolve plugins from the directory where tsconfig.json is located
      allowLocalPluginLoads: false,
      session: undefined,
    });

    projSvc.setHostConfiguration({
      formatOptions: projSvc.getHostFormatCodeOptions(),
      extraFileExtensions: [
        {
          // TODO: in View Engine getExternalFiles() returns a list of external
          // templates (HTML files). This configuration is no longer needed in
          // Ivy because Ivy returns the typecheck files.
          extension: '.pug',
          isMixedContent: false,
          scriptKind: ts.ScriptKind.Unknown,
        },
        {
          // TODO: in View Engine getExternalFiles() returns a list of external
          // templates (HTML files). This configuration is no longer needed in
          // Ivy because Ivy returns the typecheck files.
          extension: '.html',
          isMixedContent: false,
          scriptKind: ts.ScriptKind.Unknown,
        },
      ],
      preferences: {
        // We don't want the AutoImportProvider projects to be created. See
        // https://devblogs.microsoft.com/typescript/announcing-typescript-4-0/#smarter-auto-imports
        includePackageJsonAutoImports: 'off',
      },
      watchOptions: {
        // Used as watch options when not specified by user's `tsconfig`.
        watchFile: ts.WatchFileKind.UseFsEvents,
        watchDirectory: ts.WatchDirectoryKind.UseFsEvents,
        fallbackPolling: ts.PollingWatchKind.DynamicPriority,
      }
    });

    const pluginConfig: PluginConfig = {
      angularOnly: true,
    };
    if (options.forceStrictTemplates) {
      pluginConfig.forceStrictTemplates = true;
    }
    if (options.host.isG3) {
      options.ivy = true;
    }
    projSvc.configurePlugin({
      pluginName: options.ngPlugin,
      configuration: pluginConfig,
    });

    return projSvc;
  }

  private addProtocolHandlers(conn: lsp.Connection) {
    conn.onInitialize(p => this.onInitialize(p));
    conn.onDidOpenTextDocument(p => this.onDidOpenTextDocument(p));
    conn.onDidCloseTextDocument(p => this.onDidCloseTextDocument(p));
    conn.onDidChangeTextDocument(p => this.onDidChangeTextDocument(p));
    conn.onDidSaveTextDocument(p => this.onDidSaveTextDocument(p));
    conn.onDefinition(p => this.onDefinition(p));
    conn.onTypeDefinition(p => this.onTypeDefinition(p));
    conn.onReferences(p => this.onReferences(p));
    conn.onRenameRequest(p => this.onRenameRequest(p));
    conn.onPrepareRename(p => this.onPrepareRename(p));
    conn.onHover(p => this.onHover(p));
    conn.onCompletion(p => this.onCompletion(p));
    conn.onCompletionResolve(p => this.onCompletionResolve(p));
    conn.onRequest(GetComponentsWithTemplateFile, p => this.onGetComponentsWithTemplateFile(p));
    conn.onRequest(GetTemplateLocationForComponent, p => this.onGetTemplateLocationForComponent(p));
    conn.onRequest(GetTcbRequest, p => this.onGetTcb(p));
    conn.onRequest(RunNgccRequest, p => this.onRunNgcc(p));
    conn.onRequest(IsInAngularProject, p => this.isInAngularProject(p));
    conn.onCodeLens(p => this.onCodeLens(p));
    conn.onCodeLensResolve(p => this.onCodeLensResolve(p));
    conn.onSignatureHelp(p => this.onSignatureHelp(p));
  }

  private isInAngularProject(params: IsInAngularProjectParams): boolean|null {
    const filePath = utils.uriToFilePath(params.textDocument.uri);
    if (!filePath) {
      return false;
    }
    const lsAndScriptInfo = this.getLSAndScriptInfo(params.textDocument);
    if (!lsAndScriptInfo) {
      // If we cannot get language service / script info, return null to indicate we don't know
      // the answer definitively.
      return null;
    }
    const project = this.getDefaultProjectForScriptInfo(lsAndScriptInfo.scriptInfo);
    if (!project) {
      // If we cannot get project, return null to indicate we don't know
      // the answer definitively.
      return null;
    }
    const angularCore = project.getFileNames().find(isAngularCore);
    return angularCore !== undefined;
  }

  private onGetTcb(params: GetTcbParams): GetTcbResponse|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;

    let offset: number;
    if (scriptInfo.fileName.endsWith('.pug')) {
      const pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }

    const response = languageService.getTcb(scriptInfo.fileName, offset);
    if (response === undefined) {
      return null;
    }
    const {fileName: tcfName} = response;
    const tcfScriptInfo = this.projectService.getScriptInfo(tcfName);
    if (!tcfScriptInfo) {
      return null;
    }

    let tcfPugDocument: pugLs.PugDocument | null = null;
    if (tcfScriptInfo.fileName.endsWith('.pug')) {
      tcfPugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, tcfScriptInfo);

      if (tcfPugDocument.error) {
        return null;
      }

    }

    return {
      uri: utils.filePathToUri(tcfName),
      content: response.content,
      selections: response.selections.map((span => {
        return utils.tsTextSpanToLspRange(tcfPugDocument?.htmlTextDocument || tcfScriptInfo, span)
      })),
    };
  }

  private onRunNgcc(params: RunNgccParams): void {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return;
    }
    const project = this.getDefaultProjectForScriptInfo(lsInfo.scriptInfo);
    if (!project) {
      return;
    }
    this.runNgcc(project);
  }

  private onGetTemplateLocationForComponent(params: GetTemplateLocationForComponentParams):
      lsp.Location|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;

    let pugDocument;
    let offset;
    if (scriptInfo.fileName.endsWith('.pug')) {
      pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }

    const documentSpan =
        languageService.getTemplateLocationForComponent(scriptInfo.fileName, offset);
    if (documentSpan === undefined) {
      return null;
    }
    const templateScriptInfo = this.projectService.getScriptInfo(documentSpan.fileName);
    if (templateScriptInfo === undefined) {
      return null;
    }

    let range;
    if (pugDocument) {
      range = utils.translateHtmlRangeToPug(
        utils.tsTextSpanToLspRange(pugDocument.htmlTextDocument, documentSpan.textSpan),
        pugDocument
      );
    } else {
      range = utils.tsTextSpanToLspRange(scriptInfo, documentSpan.textSpan);
    }

    return lsp.Location.create(utils.filePathToUri(documentSpan.fileName), range);
  }

  private onGetComponentsWithTemplateFile(params: any): lsp.Location[]|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;
    const documentSpans = languageService.getComponentLocationsForTemplate(scriptInfo.fileName);
    const results: lsp.Location[] = [];
    for (const documentSpan of documentSpans) {
      const scriptInfo = this.projectService.getScriptInfo(documentSpan.fileName);
      if (scriptInfo === undefined) {
        continue;
      }
      const pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, lsInfo.scriptInfo);
      const range = utils.translateHtmlRangeToPug(
        utils.tsTextSpanToLspRange(pugDocument.htmlTextDocument, documentSpan.textSpan),
        pugDocument
      );
      results.push(lsp.Location.create(utils.filePathToUri(documentSpan.fileName), range));
    }
    return results;
  }

  private onSignatureHelp(params: lsp.SignatureHelpParams): lsp.SignatureHelp|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }

    const {languageService, scriptInfo} = lsInfo;

    let offset: number;
    let pugDocument: pugLs.PugDocument;

    if (scriptInfo.fileName.endsWith('.pug')) {
      pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
          utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }


    const help = languageService.getSignatureHelpItems(scriptInfo.fileName, offset, undefined);
    if (help === undefined) {
      return null;
    }

    return {
      activeParameter: help.argumentCount > 0 ? help.argumentIndex : null,
      activeSignature: help.selectedItemIndex,
      signatures: help.items.map((item: ts.SignatureHelpItem): lsp.SignatureInformation => {
        // For each signature, build up a 'label' which represents the full signature text, as well
        // as a parameter list where each parameter label is a span within the signature label.
        let label = utils.tsDisplayPartsToText(item.prefixDisplayParts);
        const parameters: lsp.ParameterInformation[] = [];
        let first = true;
        for (const param of item.parameters) {
          if (!first) {
            label += utils.tsDisplayPartsToText(item.separatorDisplayParts);
          }
          first = false;

          // Add the parameter to the label, keeping track of its start and end positions.
          const start = label.length;
          label += utils.tsDisplayPartsToText(param.displayParts);
          const end = label.length;

          // The parameter itself uses a range within the signature label as its own label.
          parameters.push({
            label: [start, end],
            documentation: utils.tsDisplayPartsToText(param.documentation),
          });
        }

        label += utils.tsDisplayPartsToText(item.suffixDisplayParts);
        return {
          label,
          documentation: utils.tsDisplayPartsToText(item.documentation),
          parameters,
        };
      }),
    };
  }

  private onCodeLens(params: lsp.CodeLensParams): lsp.CodeLens[]|null {
    if (!(params.textDocument.uri.endsWith('.html') || params.textDocument.uri.endsWith('.pug')) || !this.isInAngularProject(params)) {
      return null;
    }
    const position = lsp.Position.create(0, 0);
    const topOfDocument = lsp.Range.create(position, position);

    const codeLens: lsp.CodeLens = {
      range: topOfDocument,
      data: params.textDocument,
    };

    return [codeLens];
  }

  private onCodeLensResolve(params: lsp.CodeLens): lsp.CodeLens {
    const components = this.onGetComponentsWithTemplateFile({textDocument: params.data});
    if (components === null || components.length === 0) {
      // While the command is supposed to be optional, vscode will show `!!MISSING: command!!` that
      // fails if you click on it when a command is not provided. Instead, throwing an error will
      // make vscode show the text "no commands" (and it's not a link).
      // It is documented that code lens resolution can throw an error:
      // https://microsoft.github.io/language-server-protocol/specification#codeLens_resolve
      throw new Error(
          'Could not determine component for ' + (params.data as lsp.TextDocumentIdentifier).uri);
    }
    params.command = {
      command: 'angular.goToComponentWithTemplateFile',
      title: components.length > 1 ? `Used as templateUrl in ${components.length} components` :
                                     'Go to component',
    };
    return params;
  }

  private enableLanguageServiceForProject(project: ts.server.Project): void {
    const {projectName} = project;
    if (project.isClosed()) {
      this.info(`Cannot enable language service for closed project ${projectName}.`);
      return;
    }
    if (!project.languageServiceEnabled) {
      project.enableLanguageService();
      // When the language service got disabled, the program was discarded via
      // languageService.cleanupSemanticCache(). However, the program is not
      // recreated when the language service is re-enabled. We manually mark the
      // project as dirty to force update the graph.
      project.markAsDirty();
    }
    if (!this.ivy) {
      // Immediately enable Legacy / View Engine language service
      this.info(`Enabling View Engine language service for ${projectName}.`);
      return;
    }
    this.info(`Enabling Ivy language service for ${projectName}.`);
    this.handleCompilerOptionsDiagnostics(project);
    // Send diagnostics since we skipped this step when opening the file
    // (because language service was disabled while waiting for ngcc).
    // First, make sure the Angular project is complete.
    this.runGlobalAnalysisForNewlyLoadedProject(project);
  }

  private disableLanguageServiceForProject(project: ts.server.Project, reason: string): void {
    if (!project.languageServiceEnabled) {
      return;
    }
    project.disableLanguageService(
        `Disabling language service for ${project.projectName} because ${reason}.`);
  }


  /**
   * Invoke the compiler for the first time so that external templates get
   * matched to the project they belong to.
   */
  private runGlobalAnalysisForNewlyLoadedProject(project: ts.server.Project): void {
    if (!project.hasRoots()) {
      return;
    }
    const fileName = project.getRootScriptInfos()[0].fileName;
    const label = `Global analysis - getSemanticDiagnostics for ${fileName}`;
    if (utils.isDebugMode) {
      console.time(label);
    }
    // Getting semantic diagnostics will trigger a global analysis.
    project.getLanguageService().getSemanticDiagnostics(fileName);
    if (utils.isDebugMode) {
      console.timeEnd(label);
    }
  }

  private handleCompilerOptionsDiagnostics(project: ts.server.Project): void {
    if (!utils.isConfiguredProject(project)) {
      return;
    }

    const diags = project.getLanguageService().getCompilerOptionsDiagnostics();
    const suggestStrictModeDiag = diags.find(d => d.code === -9910001);

    if (suggestStrictModeDiag) {
      const configFilePath: string = project.getConfigFilePath();
      this.connection.sendNotification(SuggestStrictMode, {
        configFilePath,
        message: suggestStrictModeDiag.messageText,
      });
      this.renameDisabledProjects.add(project);
    } else {
      this.renameDisabledProjects.delete(project);
    }
  }

  /**
   * An event handler that gets invoked whenever the program changes and
   * TS ProjectService sends `ProjectUpdatedInBackgroundEvent`. This particular
   * event is used to trigger diagnostic checks.
   * @param event
   */
  private handleProjectServiceEvent(event: ts.server.ProjectServiceEvent) {
    switch (event.eventName) {
      case ts.server.ProjectLoadingStartEvent:
        this.isProjectLoading = true;
        this.connection.sendNotification(ProjectLoadingStart);
        this.logger.info(`Loading new project: ${event.data.reason}`);
        break;
      case ts.server.ProjectLoadingFinishEvent: {
        if (this.isProjectLoading) {
          this.isProjectLoading = false;
          this.connection.sendNotification(ProjectLoadingFinish);
        }
        const {project} = event.data;
        const angularCore = this.findAngularCore(project);
        if (angularCore) {
          if (this.ivy && isExternalAngularCore(angularCore) && !this.disableAutomaticNgcc) {
            // Do not wait on this promise otherwise we'll be blocking other requests
            this.runNgcc(project);
          } else {
            this.enableLanguageServiceForProject(project);
          }
        } else {
          this.disableLanguageServiceForProject(
              project, `project is not an Angular project ('@angular/core' could not be found)`);
        }
        break;
      }
      case ts.server.ProjectsUpdatedInBackgroundEvent:
        // ProjectsUpdatedInBackgroundEvent is sent whenever diagnostics are
        // requested via project.refreshDiagnostics()
        this.triggerDiagnostics(event.data.openFiles, event.eventName);
        break;
      case ts.server.ProjectLanguageServiceStateEvent:
        this.connection.sendNotification(ProjectLanguageService, {
          projectName: event.data.project.getProjectName(),
          languageServiceEnabled: event.data.languageServiceEnabled,
        });
    }
  }

  /**
   * Request diagnostics to be computed due to the specified `file` being opened
   * or changed.
   * @param file File opened / changed
   * @param reason Trace to explain why diagnostics are requested
   */
  private requestDiagnosticsOnOpenOrChangeFile(file: string, reason: string): void {
    const files: string[] = [];
    if (isExternalTemplate(file)) {
      // If only external template is opened / changed, we know for sure it will
      // not affect other files because it is local to the Component.
      files.push(file);
    } else {
      // Get all open files, most recently used first.
      for (const openFile of this.openFiles.getAll()) {
        const scriptInfo = this.projectService.getScriptInfo(openFile);
        if (scriptInfo) {
          files.push(scriptInfo.fileName);
        }
      }
    }
    this.triggerDiagnostics(files, reason);
  }

  /**
   * Retrieve Angular diagnostics for the specified `files` after a specific
   * `delay`, or renew the request if there's already a pending one.
   * @param files files to be checked
   * @param reason Trace to explain why diagnostics are triggered
   * @param delay time to wait before sending request (milliseconds)
   */
  private triggerDiagnostics(files: string[], reason: string, delay: number = 300) {
    // Do not immediately send a diagnostics request. Send only after user has
    // stopped typing after the specified delay.
    if (this.diagnosticsTimeout) {
      // If there's an existing timeout, cancel it
      clearTimeout(this.diagnosticsTimeout);
    }
    // Set a new timeout
    this.diagnosticsTimeout = setTimeout(() => {
      this.diagnosticsTimeout = null;  // clear the timeout
      this.sendPendingDiagnostics(files, reason);
      // Default delay is 200ms, consistent with TypeScript. See
      // https://github.com/microsoft/vscode/blob/7b944a16f52843b44cede123dd43ae36c0405dfd/extensions/typescript-language-features/src/features/bufferSyncSupport.ts#L493)
    }, delay);
  }

  /**
   * Execute diagnostics request for each of the specified `files`.
   * @param files files to be checked
   * @param reason Trace to explain why diagnostics is triggered
   */
  private async sendPendingDiagnostics(files: string[], reason: string) {
    for (let i = 0; i < files.length; ++i) {
      const fileName = files[i];
      const result = this.getLSAndScriptInfo(fileName);
      if (!result) {
        continue;
      }
      const label = `${reason} - getSemanticDiagnostics for ${fileName}`;
      if (utils.isDebugMode) {
        console.time(label);
      }

      let resultPugDocument: pugLs.PugDocument | null = null;
      let lspDiagnostics: lsp.Diagnostic[] = [];
      if (fileName.endsWith('.pug')) {
        resultPugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, result.scriptInfo);

        if (!resultPugDocument) {
          return;
        }

        // Show new line source maps
        // lspDiagnostics.push(...resultPugDocument
        //   .sourceMap
        //   .mappings
        //   .reduce((acc: lsp.Diagnostic[], mapping) => {
        //      if (mapping?.data?.text !== 'newline') {
        //        return acc;
        //      }

        //      acc.push({
        //        message: `Pug: ${mapping.sourceRange.start} -> ${mapping.sourceRange.end}, HTML: ${mapping.mappedRange.start} -> ${mapping.mappedRange.end}`,
        //        range: {
        //          start: resultPugDocument!.pugTextDocument.positionAt(mapping.sourceRange.start),
        //          end: resultPugDocument!.pugTextDocument.positionAt(mapping.sourceRange.end),
        //        }
        //      });

        //      return acc;
        //    }, [] as lsp.Diagnostic[])
        //  )
      }

      const diagnostics = result.languageService.getSemanticDiagnostics(fileName);
      if (utils.isDebugMode) {
        console.timeEnd(label);
      }

      const ngDiagnostics: lsp.Diagnostic[] = diagnostics
        .map(tsDiagnostic => {
          let lspDiagnostic;

          if (resultPugDocument) {
            lspDiagnostic = tsDiagnosticToLspDiagnostic(tsDiagnostic, resultPugDocument.htmlTextDocument);

            lspDiagnostic.range = utils.translateHtmlRangeToPug(lspDiagnostic.range, resultPugDocument);
          } else {
            lspDiagnostic = tsDiagnosticToLspDiagnostic(tsDiagnostic, result.scriptInfo);
          }

          return lspDiagnostic
        });

      let pugDiagnostics = [];
      if (resultPugDocument?.error) {
        pugDiagnostics.push(pugDiagnosticToLspDiagnostic(resultPugDocument?.error)!);
      }

      // Need to send diagnostics even if it's empty otherwise editor state will
      // not be updated.
      this.connection.sendDiagnostics({
        uri: utils.filePathToUri(fileName),
        diagnostics: [...ngDiagnostics, ...pugDiagnostics, ...lspDiagnostics],
      });
      if (this.diagnosticsTimeout) {
        // There is a pending request to check diagnostics for all open files,
        // so stop this one immediately.
        return;
      }
      if (i < files.length - 1) {
        // If this is not the last file, yield so that pending I/O events get a
        // chance to run. This will open an opportunity for the server to process
        // incoming requests. The next file will be checked in the next iteration
        // of the event loop.
        await setImmediateP();
      }
    }
  }

  /**
   * Return the default project for the specified `scriptInfo` if it is already
   * a configured project. If not, attempt to find a relevant config file and
   * make that project its default. This method is to ensure HTML files always
   * belong to a configured project instead of the default behavior of being in
   * an inferred project.
   * @param scriptInfo
   */
  getDefaultProjectForScriptInfo(scriptInfo: ts.server.ScriptInfo): ts.server.Project|null {
    let project = this.projectService.getDefaultProjectForFile(
        scriptInfo.fileName,
        // ensureProject tries to find a default project for the scriptInfo if
        // it does not already have one. It is not needed here because we are
        // going to assign it a project below if it does not have one.
        false  // ensureProject
    );

    // TODO: verify that HTML files are attached to Inferred project by default.
    // If they are already part of a ConfiguredProject then the following is
    // not needed.
    if (!project || project.projectKind !== ts.server.ProjectKind.Configured) {
      const {configFileName} = this.projectService.openClientFile(scriptInfo.fileName);
      if (!configFileName) {
        // Failed to find a config file. There is nothing we could do.
        this.error(`No config file for ${scriptInfo.fileName}`);
        return null;
      }
      project = this.projectService.findProject(configFileName);
      if (!project) {
        return null;
      }
      scriptInfo.detachAllProjects();
      scriptInfo.attachToProject(project);
    }
    this.createExternalProject(project);

    return project;
  }

  private onInitialize(params: lsp.InitializeParams): lsp.InitializeResult {
    this.snippetSupport =
        params.capabilities.textDocument?.completion?.completionItem?.snippetSupport;
    const serverOptions: ServerOptions = {
      logFile: this.logger.getLogFileName(),
    };
    this.clientCapabilities = params.capabilities;
    return {
      capabilities: {
        codeLensProvider: this.ivy ? {resolveProvider: true} : undefined,
        textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
        completionProvider: {
          // Only the Ivy LS provides support for additional completion resolution.
          resolveProvider: this.ivy,
          triggerCharacters: ['<', '.', '*', '[', '(', '$', '|']
        },
        definitionProvider: true,
        typeDefinitionProvider: this.ivy,
        referencesProvider: this.ivy,
        renameProvider: this.ivy ? {
          // Renames should be checked and tested before being executed.
          prepareProvider: true,
        } :
                                   false,
        hoverProvider: true,
        signatureHelpProvider: this.ivy ? {
          triggerCharacters: ['(', ','],
          retriggerCharacters: [','],
        } :
                                          undefined,
        workspace: {
          workspaceFolders: {supported: true},
        },
      },
      serverOptions,
    };
  }

  private onDidOpenTextDocument(params: lsp.DidOpenTextDocumentParams) {
    const {uri, languageId, text} = params.textDocument;
    const filePath = utils.uriToFilePath(uri);
    if (!filePath) {
      return;
    }
    this.openFiles.update(filePath);
    // External templates (HTML files) should be tagged as ScriptKind.Unknown
    // so that they don't get parsed as TS files. See
    // https://github.com/microsoft/TypeScript/blob/b217f22e798c781f55d17da72ed099a9dee5c650/src/compiler/program.ts#L1897-L1899
    const scriptKind = languageId === LanguageId.TS ? ts.ScriptKind.TS : ts.ScriptKind.Unknown;
    try {
      // The content could be newer than that on disk. This could be due to
      // buffer in the user's editor which has not been saved to disk.
      // See https://github.com/angular/vscode-ng-language-service/issues/632
      const result = this.projectService.openClientFile(filePath, text, scriptKind);

      const {configFileName, configFileErrors} = result;
      if (configFileErrors && configFileErrors.length) {
        // configFileErrors is an empty array even if there's no error, so check length.
        this.error(configFileErrors.map(e => e.messageText).join('\n'));
      }
      const project = configFileName ?
          this.projectService.findProject(configFileName) :
          this.projectService.getScriptInfo(filePath)?.containingProjects.find(utils.isConfiguredProject);
      if (!project) {
        return;
      }
      if (project.languageServiceEnabled) {
        // The act of opening a file can cause the text storage to switchToScriptVersionCache for
        // version tracking, which results in an identity change for the source file. This isn't
        // typically an issue but the identity can change during an update operation for template
        // type-checking, when we _only_ expect the typecheck files to change. This _is_ an issue
        // because the because template type-checking should not modify the identity of any other
        // source files (other than the generated typecheck files). We need to ensure that the
        // compiler is aware of this change that shouldn't have happened and recompiles the file
        // because we store references to some string expressions (inline templates, style/template
        // urls).
        project.markAsDirty();
        // Show initial diagnostics
        this.requestDiagnosticsOnOpenOrChangeFile(filePath, `Opening ${filePath}`);
      }
    } catch (error) {
      if (this.isProjectLoading) {
        this.isProjectLoading = false;
        this.connection.sendNotification(ProjectLoadingFinish);
      }
      if (error.stack) {
        this.error(error.stack);
      }
      throw error;
    }
    this.closeOrphanedExternalProjects();
  }

  /**
   * Creates an external project with the same config path as `project` so that TypeScript keeps the
   * project open when navigating away from `html` files.
   */
  private createExternalProject(project: ts.server.Project): void {
    if (utils.isConfiguredProject(project) &&
        !this.configuredProjToExternalProj.has(project.projectName)) {
      const extProjectName = `${project.projectName}-external`;
      project.projectService.openExternalProject({
        projectFileName: extProjectName,
        rootFiles: [{fileName: project.getConfigFilePath()}],
        options: {}
      });
      this.configuredProjToExternalProj.set(project.projectName, extProjectName);
    }
  }

  private onDidCloseTextDocument(params: lsp.DidCloseTextDocumentParams) {
    const {textDocument} = params;
    const filePath = utils.uriToFilePath(textDocument.uri);
    if (!filePath) {
      return;
    }
    this.openFiles.delete(filePath);
    this.projectService.closeClientFile(filePath);
  }

  /**
   * We open external projects for files so that we can prevent TypeScript from closing a project
   * when there is open external HTML template that still references the project. This function
   * checks if there are no longer any open files in any external project. If there
   * aren't, we also close the external project that was created.
   */
  private closeOrphanedExternalProjects(): void {
    for (const [configuredProjName, externalProjName] of this.configuredProjToExternalProj) {
      const configuredProj = this.projectService.findProject(configuredProjName);
      if (!configuredProj || configuredProj.isClosed()) {
        this.projectService.closeExternalProject(externalProjName);
        this.configuredProjToExternalProj.delete(configuredProjName);
        continue;
      }
      // See if any openFiles belong to the configured project.
      // if not, close external project this.projectService.openFiles
      const openFiles = toArray(this.projectService.openFiles.keys());
      if (!openFiles.some(file => {
            const scriptInfo = this.projectService.getScriptInfo(file);
            return scriptInfo?.isAttached(configuredProj);
          })) {
        this.projectService.closeExternalProject(externalProjName);
        this.configuredProjToExternalProj.delete(configuredProjName);
      }
    }
  }

  private onDidChangeTextDocument(params: lsp.DidChangeTextDocumentParams): void {
    const {contentChanges, textDocument} = params;
    const filePath = utils.uriToFilePath(textDocument.uri);
    if (!filePath) {
      return;
    }
    this.openFiles.update(filePath);
    const scriptInfo = this.projectService.getScriptInfo(filePath);
    if (!scriptInfo) {
      this.error(`Failed to get script info for ${filePath}`);
      return;
    }
    for (const change of contentChanges) {
      if ('range' in change) {
        const start = scriptInfo.lineOffsetToPosition(change.range.start.line + 1, change.range.start.character + 1);
        const end = scriptInfo.lineOffsetToPosition(change.range.end.line + 1, change.range.end.character + 1);

        scriptInfo.editContent(start, end, change.text);
      } else {
        // New text is considered to be the full content of the document.
        scriptInfo.editContent(0, scriptInfo.getSnapshot().getLength(), change.text);
      }
    }

    const project = this.getDefaultProjectForScriptInfo(scriptInfo);
    if (!project || !project.languageServiceEnabled) {
      return;
    }
    this.requestDiagnosticsOnOpenOrChangeFile(scriptInfo.fileName, `Changing ${filePath}`);
  }

  private onDidSaveTextDocument(params: lsp.DidSaveTextDocumentParams): void {
    const {text, textDocument} = params;
    const filePath = utils.uriToFilePath(textDocument.uri);
    if (!filePath) {
      return;
    }
    this.openFiles.update(filePath);
    const scriptInfo = this.projectService.getScriptInfo(filePath);
    if (!scriptInfo) {
      return;
    }
    if (text) {
      scriptInfo.open(text);
    } else {
      scriptInfo.reloadFromFile();
    }
  }

  private onDefinition(params: lsp.TextDocumentPositionParams): lsp.LocationLink[]|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;

    let pugDocument: pugLs.PugDocument | null = null;
    let offset: number;
    if (scriptInfo.fileName.endsWith('.pug')) {
      pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }

    const definition = languageService.getDefinitionAndBoundSpan(scriptInfo.fileName, offset);
    if (!definition || !definition.definitions) {
      return null;
    }

    let originSelectionRange;
    if (pugDocument) {
      originSelectionRange = utils.translateHtmlRangeToPug(
        utils.tsTextSpanToLspRange(
          pugDocument.htmlTextDocument,
          definition.textSpan
        ),
        pugDocument,
      );
    } else {
      originSelectionRange = utils.tsTextSpanToLspRange(scriptInfo, definition.textSpan);
    }

    return this.tsDefinitionsToLspLocationLinks(definition.definitions, originSelectionRange);
  }

  private onTypeDefinition(params: lsp.TextDocumentPositionParams): lsp.LocationLink[]|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;

    let pugDocument: pugLs.PugDocument | null = null;
    let offset: number;
    if (scriptInfo.fileName.endsWith('.pug')) {
      pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }

    const definitions = languageService.getTypeDefinitionAtPosition(scriptInfo.fileName, offset);
    if (!definitions) {
      return null;
    }
    return this.tsDefinitionsToLspLocationLinks(definitions);
  }

  private onRenameRequest(params: lsp.RenameParams): lsp.WorkspaceEdit|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;
    const project = this.getDefaultProjectForScriptInfo(scriptInfo);
    if (project === null || this.renameDisabledProjects.has(project)) {
      return null;
    }

    let pugDocument: pugLs.PugDocument | null = null;
    let offset: number;
    if (scriptInfo.fileName.endsWith('.pug')) {
      pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }

    const renameLocations = languageService.findRenameLocations(
        scriptInfo.fileName, offset, /*findInStrings*/ false, /*findInComments*/ false);
    if (renameLocations === undefined) {
      return null;
    }

    const changes = renameLocations.reduce((changes, location) => {
      let uri: lsp.URI = utils.filePathToUri(location.fileName);
      if (changes[uri] === undefined) {
        changes[uri] = [];
      }
      const fileEdits = changes[uri];

      const lsInfo = this.getLSAndScriptInfo(location.fileName);
      if (lsInfo === null) {
        return changes;
      }

      let pugDocument: pugLs.PugDocument | null = null;
      let range: lsp.Range;

      if (scriptInfo.fileName.endsWith('.pug')) {
        pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

        if (pugDocument.error) {
          return changes;
        }

        range = utils.translateHtmlRangeToPug(
          utils.tsTextSpanToLspRange(pugDocument.htmlTextDocument, location.textSpan),
          pugDocument
        );
      } else {
        range = utils.tsTextSpanToLspRange(scriptInfo, location.textSpan);
      }

      fileEdits.push({range, newText: params.newName});
      return changes;
    }, {} as {[uri: string]: lsp.TextEdit[]});

    return {changes};
  }

  private onPrepareRename(params: lsp.PrepareRenameParams):
      {range: lsp.Range, placeholder: string}|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;
    const project = this.getDefaultProjectForScriptInfo(scriptInfo);
    if (project === null || this.renameDisabledProjects.has(project)) {
      return null;
    }

    let pugDocument: pugLs.PugDocument | null = null;
    let offset: number;
    if (scriptInfo.fileName.endsWith('.pug')) {
      pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }

    const renameInfo = languageService.getRenameInfo(scriptInfo.fileName, offset);
    if (!renameInfo.canRename) {
      return null;
    }

    let range;
    if (pugDocument) {
      range = utils.translateHtmlRangeToPug(
        utils.tsTextSpanToLspRange(pugDocument.htmlTextDocument, renameInfo.triggerSpan),
        pugDocument
      );
    } else {
      range = utils.tsTextSpanToLspRange(scriptInfo, renameInfo.triggerSpan);
    }

    return {
      range,
      placeholder: renameInfo.displayName,
    };
  }

  private onReferences(params: lsp.TextDocumentPositionParams): lsp.Location[]|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;

    let pugDocument: pugLs.PugDocument | null = null;
    let offset: number;
    if (scriptInfo.fileName.endsWith('.pug')) {
      pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }

    const references = languageService.getReferencesAtPosition(scriptInfo.fileName, offset);
    if (references === undefined) {
      return null;
    }
    return references.map(ref => {
      const scriptInfo = this.projectService.getScriptInfo(ref.fileName);

      let range;
      if (pugDocument) {
        range = utils.translateHtmlRangeToPug(
          utils.tsTextSpanToLspRange(pugDocument.htmlTextDocument, ref.textSpan),
          pugDocument
        );
      } else if (scriptInfo) {
        range = utils.tsTextSpanToLspRange(scriptInfo, ref.textSpan);
      } else {
        range = EMPTY_RANGE;
      }

      const uri = utils.filePathToUri(ref.fileName);
      return {uri, range};
    });
  }

  private tsDefinitionsToLspLocationLinks(
      definitions: readonly ts.DefinitionInfo[],
      originSelectionRange?: lsp.Range): lsp.LocationLink[] {
    const results: lsp.LocationLink[] = [];
    for (const d of definitions) {
      const scriptInfo = this.projectService.getScriptInfo(d.fileName);

      // Some definitions, like definitions of CSS files, may not be recorded files with a
      // `scriptInfo` but are still valid definitions because they are files that exist. In this
      // case, check to make sure that the text span of the definition is zero so that the file
      // doesn't have to be read; if the span is non-zero, we can't do anything with this
      // definition.
      if (!scriptInfo && d.textSpan.length > 0) {
        continue;
      }

      let mappedInfo = d;
      let range = EMPTY_RANGE;
      if (scriptInfo) {
        const project = this.getDefaultProjectForScriptInfo(scriptInfo);
        mappedInfo = project ? utils.getMappedDefinitionInfo(d, project) : mappedInfo;
        // After the DTS file maps to original source file, the `scriptInfo` should be updated.
        const originalScriptInfo =
            this.projectService.getScriptInfo(mappedInfo.fileName) ?? scriptInfo;
        const pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, originalScriptInfo);

        if (pugDocument) {
          range = utils.translateHtmlRangeToPug(
            utils.tsTextSpanToLspRange(pugDocument.htmlTextDocument, mappedInfo.textSpan),
            pugDocument
          );
        } else {
          range = utils.tsTextSpanToLspRange(scriptInfo, mappedInfo.textSpan);
        }
      }

      const targetUri = utils.filePathToUri(mappedInfo.fileName);
      results.push({
        originSelectionRange,
        targetUri,
        targetRange: range,
        targetSelectionRange: range,
      });
    }
    return results;
  }

  private getLSAndScriptInfo(textDocumentOrFileName: lsp.TextDocumentIdentifier|string):
      {languageService: NgLanguageService, scriptInfo: ts.server.ScriptInfo}|null {
    const filePath = lsp.TextDocumentIdentifier.is(textDocumentOrFileName) ?
        utils.uriToFilePath(textDocumentOrFileName.uri) :
        textDocumentOrFileName;
    const scriptInfo = this.projectService.getScriptInfo(filePath);
    if (!scriptInfo) {
      this.error(`Script info not found for ${filePath}`);
      return null;
    }

    const project = this.getDefaultProjectForScriptInfo(scriptInfo);
    if (!project?.languageServiceEnabled) {
      return null;
    }
    if (project.isClosed()) {
      scriptInfo.detachFromProject(project);
      this.logger.info(`Failed to get language service for closed project ${project.projectName}.`);
      return null;
    }
    const languageService = project.getLanguageService();
    if (!isNgLanguageService(languageService)) {
      return null;
    }
    return {
      languageService,
      scriptInfo,
    };
  }

  private onHover(params: lsp.TextDocumentPositionParams): lsp.Hover|null {
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return null;
    }
    const {languageService, scriptInfo} = lsInfo;

    let pugDocument: pugLs.PugDocument | null = null;
    let offset: number;
    if (scriptInfo.fileName.endsWith('.pug')) {
      pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return null;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          params.position,
          pugDocument,
        )
      );

      const pugInfo = this.pugLs.doHover(pugDocument, params.position) || null;
      if (pugInfo) {
        return pugInfo;
      }
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, params.position);
    }

    const info = languageService.getQuickInfoAtPosition(scriptInfo.fileName, offset);
    if (!info) {
      return null;
    }

    const {kind, kindModifiers, textSpan, displayParts, documentation} = info;
    let desc = kindModifiers ? kindModifiers + ' ' : '';
    if (displayParts && displayParts.length > 0) {
      // displayParts does not contain info about kindModifiers
      // but displayParts does contain info about kind
      desc += displayParts.map(dp => dp.text).join('');
    } else {
      desc += kind;
    }
    const contents: lsp.MarkedString[] = [{
      language: 'typescript',
      value: desc,
    }];
    if (documentation) {
      for (const d of documentation) {
        contents.push(d.text);
      }
    }

    let range: lsp.Range;
    if (pugDocument) {
      range = utils.translateHtmlRangeToPug(
        utils.tsTextSpanToLspRange(pugDocument.htmlTextDocument, textSpan),
        pugDocument
      );
    } else {
      range = utils.tsTextSpanToLspRange(scriptInfo, textSpan);
    }

    return {
      contents,
      range,
    };
  }

  private async onCompletion(params: lsp.CompletionParams): Promise<lsp.CompletionItem[]|null> {
    // Note: *ngIf="" completions inside the quotes don't work even in the original code
    const lsInfo = this.getLSAndScriptInfo(params.textDocument);
    if (lsInfo === null) {
      return new Promise(() => null);
    }
    const {languageService, scriptInfo} = lsInfo;

    let options: ts.GetCompletionsAtPositionOptions = {};
    const includeCompletionsWithSnippetText =
        this.includeCompletionsWithSnippetText && this.snippetSupport;
    if (this.includeAutomaticOptionalChainCompletions || includeCompletionsWithSnippetText) {
      options = {
        includeAutomaticOptionalChainCompletions: this.includeAutomaticOptionalChainCompletions,
        includeCompletionsWithSnippetText: includeCompletionsWithSnippetText,
        includeCompletionsWithInsertText:
            this.includeAutomaticOptionalChainCompletions || includeCompletionsWithSnippetText,
      };
    }

    const clientSupportsInsertReplaceCompletion =
        this.clientCapabilities.textDocument?.completion?.completionItem?.insertReplaceSupport ??
        false;

    let ngCompletions;
    if (!scriptInfo.fileName.endsWith('.pug')) {
      return getHtmlCompletions(
        scriptInfo,
        languageService,
        params.position,
        options,
        clientSupportsInsertReplaceCompletion,
        this.ivy
      );
    }

    const documentSnapshot = scriptInfo.getSnapshot()
    const documentText = documentSnapshot
      .getText(0, documentSnapshot.getLength());

    let pugDocument = this.pugLs.parsePugDocument(documentText);

    if (pugDocument.error) {
      return null;
    }

    const pugCursorPosition = {line: params.position.line, character: params.position.character};
    const pugCursorOffset = pugDocument.pugTextDocument.offsetAt(pugCursorPosition);

    const lineStart = pugDocument.pugTextDocument.getText({start: {line: pugCursorPosition.line, character: 0}, end: {line: pugCursorPosition.line + 1, character: 0}}).trimLeft();

    if (lineStart.startsWith('|') || lineStart.startsWith('-')) {
      // | (pipe) is for whitespace control in strings so nothing following it can have autocomplete
      // - neither for hyphen because that's a js line
      return null;
    }

    const htmlCursorOffset = pugDocument.sourceMap.getMappedRange(pugCursorOffset)?.[0].start

    if (htmlCursorOffset === undefined) {
      // Some error has occured, return no results
      return null;
    }

    const htmlCursorLocation = pugDocument.htmlTextDocument.positionAt(htmlCursorOffset);

    ngCompletions = languageService.getCompletionsAtPosition(
      scriptInfo.fileName,
      htmlCursorOffset,
      options,
    );

    let mappedCompletions: lsp.CompletionItem[] = [];
    if (ngCompletions?.entries.length) {
      mappedCompletions = ngCompletions.entries.map((e) => {
        return tsCompletionEntryToLspCompletionItem(
          e,
          {line: htmlCursorLocation.line, character: htmlCursorLocation.character},
          scriptInfo,
          clientSupportsInsertReplaceCompletion,
          this.ivy,
          pugDocument.htmlTextDocument,
        )
      });

      let bracketCorrection = 0;
      if (pugDocument.pugTextDocument.getText().substring(pugCursorOffset - 1, pugCursorOffset + 1) === '[]') {
        bracketCorrection = 1
      }

      mappedCompletions.map(c => {
        const translate = (position: lsp.Position, bracketCorrection = 0) => {
          // get pug offset of htmlcursorposition
          // subtract from pug cursor offset
          // this lets us convert angular's incorrect positions to the real positions.

          const mappedPugOffset = utils.extractOffsetFromSourceMapPosition(pugDocument.sourceMap.getSourceRange(htmlCursorOffset));

          if (!mappedPugOffset) {
            return pugCursorPosition;
          }

          const pugCorrectionOffset = pugCursorOffset - mappedPugOffset;

          const angularHtmlOffset = pugDocument.htmlTextDocument.offsetAt(position);
          const mappedAngularPugOffset = utils.extractOffsetFromSourceMapPosition(pugDocument.sourceMap.getSourceRange(angularHtmlOffset));

          if (!mappedAngularPugOffset) {
            return pugCursorPosition;
          }

          const pugDocumentLength = pugDocument.pugTextDocument.getText().length - 1;

          const sourceMapCorrectedAngularPugOffset = mappedAngularPugOffset + pugCorrectionOffset + bracketCorrection;
          const clampedSourceMapCorrectedAngularPugOffset = Math.min(Math.max(sourceMapCorrectedAngularPugOffset, 0), pugDocumentLength);

          return pugDocument.pugTextDocument.positionAt(clampedSourceMapCorrectedAngularPugOffset);
        }

        if (c?.textEdit && 'range' in c.textEdit) {
          c.textEdit.range.start = translate(c.textEdit.range.start);
          c.textEdit.range.end = translate(c.textEdit.range.end);
        }

        if (c?.textEdit && 'insert' in c.textEdit) {
          c.textEdit.insert.start = translate(c.textEdit.insert.start);
          c.textEdit.insert.end = translate(c.textEdit.insert.end, bracketCorrection);
        }

        if (c?.textEdit && 'replace' in c.textEdit) {
          c.textEdit.replace.start = translate(c.textEdit.replace.start);
          c.textEdit.replace.end = translate(c.textEdit.replace.end, bracketCorrection);
        }

        c.data.position = translate(c.data.position);
      });

    }

    const pugCompletions = await getPugCompletions(pugDocument, pugCursorPosition, htmlCursorOffset, pugCursorOffset, this.pugLs);

    const returnResults: lsp.CompletionItem[] = [];
    if (pugCompletions?.items.length) {
      returnResults.push(
        ...pugCompletions.items.filter(item => !/\/.*\>/.test(item.textEdit?.newText || ''))
      );
    }

    if (mappedCompletions.length) {
      returnResults.push(...mappedCompletions);
    }

    return returnResults || null;
  }

  private onCompletionResolve(item: lsp.CompletionItem): lsp.CompletionItem {
    const data = readNgCompletionData(item);
    if (data === null) {
      // This item wasn't tagged with Angular LS completion data - it probably didn't originate
      // from this language service.
      return item;
    }

    const {filePath, position} = data;
    const lsInfo = this.getLSAndScriptInfo(filePath);
    if (lsInfo === null) {
      return item;
    }
    const {languageService, scriptInfo} = lsInfo;

    let offset: number;
    if (scriptInfo.fileName.endsWith('.pug')) {
      const pugDocument = utils.getPugDocumentFromScriptInfo(this.pugLs, scriptInfo);

      if (pugDocument.error) {
        return item;
      }

      offset = pugDocument.htmlTextDocument.offsetAt(
        utils.translatePugPositionToHtml(
          position,
          pugDocument,
        )
      );
    } else {
      offset = utils.lspPositionToTsPosition(scriptInfo, position);
    }

    const details = languageService.getCompletionEntryDetails(
        filePath, offset, item.insertText ?? item.label, undefined, undefined, undefined,
        undefined);
    if (details === undefined) {
      return item;
    }

    const {kind, kindModifiers, displayParts, documentation} = details;
    let desc = kindModifiers ? kindModifiers + ' ' : '';
    if (displayParts && displayParts.length > 0) {
      // displayParts does not contain info about kindModifiers
      // but displayParts does contain info about kind
      desc += displayParts.map(dp => dp.text).join('');
    } else {
      desc += kind;
    }
    item.detail = desc;
    item.documentation = documentation?.map(d => d.text).join('');
    return item;
  }

  /**
   * Show an error message in the remote console and log to file.
   *
   * @param message The message to show.
   */
  error(message: string): void {
    if (this.logToConsole) {
      this.connection.console.error(message);
    }
    this.logger.msg(message, ts.server.Msg.Err);
  }

  /**
   * Show a warning message in the remote console and log to file.
   *
   * @param message The message to show.
   */
  warn(message: string): void {
    if (this.logToConsole) {
      this.connection.console.warn(message);
    }
    // ts.server.Msg does not have warning level, so log as info.
    this.logger.msg(`[WARN] ${message}`, ts.server.Msg.Info);
  }

  /**
   * Show an information message in the remote console and log to file.
   *
   * @param message The message to show.
   */
  info(message: string): void {
    if (this.logToConsole) {
      this.connection.console.info(message);
    }
    this.logger.msg(message, ts.server.Msg.Info);
  }

  /**
   * Start listening on the input stream for messages to process.
   */
  listen(): void {
    this.connection.listen();
  }

  /**
   * Find the main declaration file for `@angular/core` in the specified
   * `project`.
   *
   * @returns main declaration file in `@angular/core`.
   */
  private findAngularCore(project: ts.server.Project): string|null {
    const {projectName} = project;
    if (!project.languageServiceEnabled) {
      this.info(
          `Language service is already disabled for ${projectName}. ` +
          `This could be due to non-TS files that exceeded the size limit (${
              ts.server.maxProgramSizeForNonTsFiles} bytes).` +
          `Please check log file for details.`);
      return null;
    }
    if (!project.hasRoots() || project.isNonTsProject()) {
      return null;
    }
    const angularCore = project.getFileNames().find(isAngularCore);
    if (angularCore === undefined && project.getExcludedFiles().some(isAngularCore)) {
      this.info(
          `Please check your tsconfig.json to make sure 'node_modules' directory is not excluded.`);
    }
    return angularCore ?? null;
  }

  /**
   * Disable the language service, run ngcc, then re-enable language service.
   */
  private async runNgcc(project: ts.server.Project): Promise<void> {
    if (!utils.isConfiguredProject(project) || this.projectNgccQueue.some(p => p.project === project)) {
      return;
    }
    // Disable language service until ngcc is completed.
    this.disableLanguageServiceForProject(project, 'ngcc is running');
    const configFilePath = project.getConfigFilePath();

    const progressReporter = await this.connection.window.createWorkDoneProgress();

    progressReporter.begin('Angular', undefined, `Running ngcc for ${configFilePath}`);

    try {
      this.projectNgccQueue.push({project, done: false});
      await resolveAndRunNgcc(configFilePath, {
        report: (msg: string) => {
          progressReporter.report(msg);
        },
      });
    } catch (e) {
      this.error(
          `Failed to run ngcc for ${
              configFilePath}, language service may not operate correctly:\n` +
          `    ${e.message}`);

      this.connection.window
          .showErrorMessage<{
            action: NgccErrorMessageAction,
            title: string,
          }>(`Angular extension might not work correctly because ngcc operation failed. ` +
                 `Try to invoke ngcc manually by running 'npm/yarn run ngcc'. ` +
                 `Please see the extension output for more information.`,
             {title: 'Show output', action: NgccErrorMessageAction.showOutput})
          .then((selection) => {
            if (selection?.action === NgccErrorMessageAction.showOutput) {
              this.connection.sendNotification(OpenOutputChannel, {});
            }
          });
    } finally {
      const loadingStatus = this.projectNgccQueue.find(p => p.project === project);
      if (loadingStatus !== undefined) {
        loadingStatus.done = true;
      }
      this.connection.sendNotification(NgccProgressEnd, {
        configFilePath,
      });
      progressReporter.done();
    }

    // ngcc processes might finish out of order, but we need to re-enable the language service for
    // the projects in the same order that the ngcc processes were spawned in. With solution-style
    // configs, we need to ensure that the language service enabling respects the order that the
    // projects were defined in the references list. If we enable the language service out of order,
    // the second project in the list will request diagnostics first and then be the project that's
    // prioritized for that project's set of files. This will cause issues if the second project is,
    // for example, one that only includes `*.spec.ts` files and not the entire set of files needed
    // to compile the app (i.e. `*.module.ts`).
    const enabledProjects = new Set<ts.server.Project>();
    for (let i = 0; i < this.projectNgccQueue.length && this.projectNgccQueue[i].done; i++) {
      // Re-enable language service even if ngcc fails, because users could fix
      // the problem by running ngcc themselves. If we keep language service
      // disabled, there's no way users could use the extension even after
      // resolving ngcc issues. On the client side, we will warn users about
      // potentially degraded experience.
      const p = this.projectNgccQueue[i].project;
      this.enableLanguageServiceForProject(p);
      enabledProjects.add(p);
    }
    this.projectNgccQueue =
        this.projectNgccQueue.filter(({project}) => !enabledProjects.has(project));
  }
}

function toArray<T>(it: ts.Iterator<T>): T[] {
  const results: T[] = [];
  for (let itResult = it.next(); !itResult.done; itResult = it.next()) {
    results.push(itResult.value);
  }
  return results;
}

function isAngularCore(path: string): boolean {
  return isExternalAngularCore(path) || isInternalAngularCore(path);
}

function isExternalAngularCore(path: string): boolean {
  return path.endsWith('@angular/core/core.d.ts') || path.endsWith('@angular/core/index.d.ts');
}

function isInternalAngularCore(path: string): boolean {
  return path.endsWith('angular2/rc/packages/core/index.d.ts');
}

function isTypeScriptFile(path: string): boolean {
  return path.endsWith('.ts');
}

function isExternalTemplate(path: string): boolean {
  return !isTypeScriptFile(path);
}
