import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

const MarkdownResponse = lazy(() => import("./MarkdownResponse"));

type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  source: string;
  accessTokenExpiresAt?: number;
  modelsError?: string;
};

type ChatMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: number;
  toolCalls?: { id: string; function: { name: string; arguments: string } }[];
  toolCallId?: string;
};
type ToolActivity = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
};
type TimelineSegment =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; tool: ToolActivity };
type StreamedEvent =
  | { kind: "word"; id: string; text: string };
type ProjectContext = { projectPath: string; files: string[]; instructions: string; truncated: boolean };
type ProjectSkill = { name: string; description: string };
type ToolApproval = {
  id: string;
  sessionId: string;
  projectPath: string;
  toolName: string;
  arguments: Record<string, unknown>;
};
type UserQuestion = {
  id: string;
  sessionId: string;
  question: string;
  options: string[];
};
type ContextUsage = {
  modelId: string;
  usedTokens: number;
  limitTokens: number;
};
type Session = {
  id: string;
  title: string;
  projectPath: string;
  providerId: string;
  modelId: string;
  mode: "build" | "plan" | "discussion";
  allowAllTools: boolean;
  contextUsage?: ContextUsage | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};
type AppState = {
  projectPath: string | null;
  providers: Provider[];
  sessions: Session[];
  selectedProviderId: string | null;
  selectedModelId: string | null;
  isHyprlandSession: boolean;
};
type ChatUpdate = {
  sessionId: string;
  messageId: string;
  kind: "user" | "delta" | "round" | "done" | "stopped" | "error" | "retry" | "context" | "context_usage" | "compacting" | "compacted" | "tool_start" | "tool_result";
  delta: string;
  error?: string;
  details?: Record<string, unknown>;
};
type RetryStatus = {
  attempt: number;
  maxRetries: number;
  retryAt: number;
  reason: string;
};
type FileItem = { name: string; path: string; type: "file" | "directory" };
type MessageMenu = { messageId: string; text: string; selected: number };
type SessionContextMenu = { sessionId: string; x: number; y: number };
const localCommands = [
  { name: "help", description: "Afficher les commandes locales" },
  { name: "clear", description: "Effacer l’affichage sans supprimer l’historique" },
  { name: "skill", description: "Gérer les skills Claude Code du projet" },
  { name: "skills", description: "Gérer les skills Claude Code du projet" },
  { name: "terminal", description: "Ouvrir un terminal local avec confirmation" },
];
const commandPaletteActions = [
  { label: "Changer de session", description: "Afficher les conversations enregistrées", shortcut: "↵" },
  { label: "Sélectionner un modèle", description: "Choisir parmi les modèles disponibles", shortcut: "↵" },
  { label: "Nouvelle session", description: "Créer une conversation", shortcut: "↵" },
  { label: "Supprimer la session", description: "Supprimer la conversation active", shortcut: "↵" },
  { label: "Fermer l’application", description: "Quitter LUCY", shortcut: "↵" },
  { label: "Fermer le menu", description: "Retourner à la conversation", shortcut: "Échap" },
];

const toolNameLabels: Record<string, string> = {
  ask_user: "Question à l’utilisateur",
  bash: "Commande terminal",
  edit: "Modification de fichier",
  glob: "Recherche de fichiers",
  grep: "Recherche dans les fichiers",
  list: "Liste du dossier",
  list_files: "Liste du dossier",
  read: "Lecture de fichier",
  read_file: "Lecture de fichier",
  read_skill: "Lecture d’un skill",
  report_progress: "Avancement",
  run_shell: "Commande terminal",
  task: "Tâche déléguée",
  webfetch: "Lecture d’une page web",
  websearch: "Recherche web",
  write: "Écriture de fichier",
  write_file: "Écriture de fichier",
};
const toolArgumentLabels: Record<string, string> = {
  command: "Commande",
  content: "Contenu",
  description: "Description",
  filePath: "Fichier",
  file_path: "Fichier",
  include: "Filtre",
  limit: "Limite",
  name: "Nom",
  newString: "Nouveau contenu",
  new_string: "Nouveau contenu",
  offset: "Départ",
  oldString: "Ancien contenu",
  old_string: "Ancien contenu",
  options: "Choix proposés",
  path: "Chemin",
  pattern: "Motif",
  question: "Question",
  query: "Recherche",
  summary: "Résumé",
  url: "Adresse",
};

const formatToolName = (name: string) => toolNameLabels[name.toLowerCase()] ??
  name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const formatToolValue = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (Array.isArray(value)) return value.map(formatToolValue).join("\n");
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  if (typeof value === "boolean") return value ? "Oui" : "Non";
  return String(value ?? "");
};

const formatToolArguments = (tool: ToolActivity) => {
  const args = tool.arguments;
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return "Aucun paramètre";
  return entries.map(([key, value]) => {
    const label = key === "path" && ["edit", "write", "write_file"].includes(tool.name.toLowerCase())
      ? "Fichier"
      : toolArgumentLabels[key] ?? key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    const numericValue = ["offset", "limit"].includes(key) ? Number(value) : Number.NaN;
    const renderedValue = Number.isFinite(numericValue) && String(value).trim() !== ""
      ? String(numericValue)
      : formatToolValue(value);
    return `${label} :\n${renderedValue}`;
  }).join("\n\n");
};

function TerminalToolActivity({ tool, animate }: { tool: ToolActivity; animate: boolean }) {
  const fullInput = formatToolArguments(tool);
  const [visibleCharacters, setVisibleCharacters] = useState(0);
  const characters = useMemo(() => Array.from(fullInput), [fullInput]);
  const displayedCharacters = animate ? visibleCharacters : characters.length;
  const inputComplete = displayedCharacters >= characters.length;

  useEffect(() => {
    setVisibleCharacters(animate ? 0 : characters.length);
    if (!animate || characters.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisibleCharacters(characters.length);
      return;
    }
    let written = 0;
    const timer = window.setInterval(() => {
      written = Math.min(characters.length, written + 3);
      setVisibleCharacters(written);
      if (written >= characters.length) window.clearInterval(timer);
    }, 18);
    return () => window.clearInterval(timer);
  }, [animate, characters]);

  return (
    <details className={`tool-activity terminal-tool ${tool.result !== undefined ? "complete" : "running"}`} open>
      <summary>
        <span className="terminal-tool-led" />
        <span className="terminal-tool-name">{formatToolName(tool.name)}</span>
        <span className="terminal-tool-state">{tool.result !== undefined ? "TERMINÉ" : inputComplete ? "EN COURS" : "PRÉPARATION"}</span>
      </summary>
      <pre className={`tool-input ${!inputComplete ? "tool-input-streaming" : ""}`}>
        <span className="terminal-tool-prompt" aria-hidden="true">❯ </span>
        {characters.slice(0, displayedCharacters).join("")}
        {!inputComplete && <span className="terminal-tool-cursor" aria-hidden="true">▌</span>}
      </pre>
      {tool.result !== undefined && (
        <div className="terminal-tool-output">
          <div className="terminal-output-label"><span>↳</span> SORTIE</div>
          <pre>{tool.result.trim() || "Commande terminée sans sortie."}</pre>
        </div>
      )}
    </details>
  );
}

const friendlyError = (error: unknown) => error instanceof Error ? error.message : String(error);

function App() {
  const [appState, setAppState] = useState<AppState>({
    projectPath: null, providers: [], sessions: [], selectedProviderId: null, selectedModelId: null, isHyprlandSession: false,
  });
  const [sessionId, setSessionId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<"build" | "plan" | "discussion">("build");
  const [input, setInput] = useState("");
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0);
  const [draftMessage, setDraftMessage] = useState<ChatMessage | null>(null);
  const [draftAnswer, setDraftAnswer] = useState<ChatMessage | null>(null);
  const [clearedChat, setClearedChat] = useState<{ sessionId: string; messageCount: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageMenu | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenu | null>(null);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editedText, setEditedText] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retryStatus, setRetryStatus] = useState<RetryStatus | null>(null);
  const [retryClock, setRetryClock] = useState(() => Date.now());
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [activePanel, setActivePanel] = useState<"files" | "sessions" | "mcp">("files");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [showProvider, setShowProvider] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [commandPalette, setCommandPalette] = useState<"main" | "sessions" | "models" | null>(null);
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillForm, setSkillForm] = useState({ name: "", description: "", instructions: "" });
  const [providerForm, setProviderForm] = useState({
    id: "", name: "", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", models: "",
  });
  const [showCommand, setShowCommand] = useState(false);
  const [shellCommand, setShellCommand] = useState("");
  const [pendingApproval, setPendingApproval] = useState<ToolApproval | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestion | null>(null);
  const [questionAnswer, setQuestionAnswer] = useState("");
  const [liveTimeline, setLiveTimeline] = useState<TimelineSegment[]>([]);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextCompacting, setContextCompacting] = useState(false);
  const [contextMeterOpen, setContextMeterOpen] = useState(false);
  const chatScroll = useRef<HTMLDivElement>(null);
  const chatContent = useRef<HTMLDivElement>(null);
  const chatScrollFrame = useRef<number | null>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const terminalEditor = useRef<HTMLDivElement>(null);
  const terminalCaretMirror = useRef<HTMLDivElement>(null);
  const [terminalCursor, setTerminalCursor] = useState({ left: 0, top: 0, visible: false, tick: 0 });
  const initialChatFocusApplied = useRef(false);
  const messageMenuRef = useRef<HTMLDivElement>(null);
  const stickToChatBottom = useRef(true);
  const touchStartY = useRef<number | null>(null);
  const streamedEvents = useRef<StreamedEvent[]>([]);
  const incompleteWord = useRef("");
  const lastStreamMessageId = useRef("");
  const streamComplete = useRef(false);
  const windowControls = isTauri() ? getCurrentWindow() : null;
  const projectPath = appState.projectPath ?? "";
  const currentSession = appState.sessions.find((session) => session.id === sessionId);
  const contextUsage = currentSession?.contextUsage?.modelId === modelId ? currentSession.contextUsage : null;
  const contextPercent = contextUsage && contextUsage.limitTokens > 0
    ? Math.min(100, Math.round(contextUsage.usedTokens * 100 / contextUsage.limitTokens))
    : 0;
  const currentProvider = appState.providers.find((provider) => provider.id === providerId);
  const paletteModels = useMemo(() => appState.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      modelId: model,
      label: `${provider.name} / ${model}`,
    })),
  ), [appState.providers]);
  const visibleSessions = useMemo(
    () => appState.sessions.filter((session) => session.title.toLowerCase().includes(search.toLowerCase())),
    [appState.sessions, search],
  );
  const visibleFiles = useMemo(
    () => files.filter((file) => showHiddenFiles || !file.name.startsWith(".")),
    [files, showHiddenFiles],
  );
  const commandSuggestions = input.startsWith("/")
    ? localCommands.filter((command) => command.name.startsWith(input.slice(1).split(/\s+/)[0].toLowerCase())).slice(0, 5)
    : [];
  const modalOpen = Boolean(showProvider || showSkills || showCommand || pendingApproval || pendingQuestion || messageMenu || commandPalette);

  const scrollChatToBottom = useCallback(() => {
    const container = chatScroll.current;
    if (container && stickToChatBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  const updateTerminalCursor = useCallback(() => {
    const textarea = composerInput.current;
    const editor = terminalEditor.current;
    const mirror = terminalCaretMirror.current;
    if (!textarea || !editor || !mirror) return;

    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    if (selectionStart !== selectionEnd) {
      setTerminalCursor((cursor) => cursor.visible ? { ...cursor, visible: false } : cursor);
      return;
    }

    const style = window.getComputedStyle(textarea);
    const fontSize = Number.parseFloat(style.fontSize);
    const lineHeight = Number.parseFloat(style.lineHeight);
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.font = style.font;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.padding = style.padding;
    mirror.textContent = "";
    mirror.append(document.createTextNode(textarea.value.slice(0, selectionStart)));
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.append(marker);

    const markerRect = marker.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const left = Math.round((markerRect.left - editorRect.left) * 100) / 100;
    const top = Math.round((markerRect.top - editorRect.top - textarea.scrollTop - Math.max(0, (lineHeight - fontSize) / 2)) * 100) / 100;
    setTerminalCursor((cursor) => cursor.left === left && cursor.top === top && cursor.visible
      ? cursor
      : { left, top, visible: true, tick: cursor.tick + 1 });
  }, []);

  const syncState = useCallback(async () => {
    const next = await invoke<AppState>("load_app_state");
    setAppState(next);
  }, []);

  const syncFiles = useCallback(async (path = projectPath) => {
    if (!path) return;
    const items = await invoke<FileItem[]>("list_project_files", { projectPath: path, requestedPath: path });
    setFiles(items);
    setFilePath(path);
    setFileContent("");
  }, [projectPath]);

  const refreshExplorer = useCallback(async () => {
    if (!projectPath) return;
    const showingPreview = fileContent.length > 0;
    const directory = showingPreview
      ? filePath.slice(0, filePath.lastIndexOf("/")) || projectPath
      : filePath || projectPath;
    const items = await invoke<FileItem[]>("list_project_files", {
      projectPath,
      requestedPath: directory,
    });
    setFiles(items);
    if (showingPreview) {
      const updatedContent = await invoke<string>("read_project_file", {
        projectPath,
        requestedPath: filePath,
      });
      setFileContent(updatedContent);
    }
  }, [fileContent, filePath, projectPath]);

  useEffect(() => {
    if (!retryStatus) return;
    const timer = window.setInterval(() => setRetryClock(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [retryStatus?.retryAt]);

  useEffect(() => {
    if (!ready || !sessionId || !projectPath || initialChatFocusApplied.current) return;
    initialChatFocusApplied.current = true;
    window.requestAnimationFrame(() => composerInput.current?.focus());
  }, [ready, sessionId, projectPath]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(updateTerminalCursor);
    return () => window.cancelAnimationFrame(frame);
  }, [input, updateTerminalCursor]);

  useEffect(() => {
    const editor = terminalEditor.current;
    if (!editor) return;
    const observer = new ResizeObserver(updateTerminalCursor);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [updateTerminalCursor]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      const nextEvent = streamedEvents.current.shift();
      if (nextEvent?.kind === "word") {
        setLiveTimeline((segments) => {
          const last = segments.at(-1);
          if (last?.kind === "text" && last.id === nextEvent.id) {
            return [...segments.slice(0, -1), { ...last, text: last.text + nextEvent.text }];
          }
          return [...segments, { kind: "text", id: nextEvent.id, text: nextEvent.text }];
        });
        return;
      }
      if (!streamComplete.current || streamedEvents.current.length > 0) return;
      streamComplete.current = false;
      setBusy(false);
      setContextLoading(false);
      setPendingQuestion(null);
      void syncState().then(() => {
        setDraftMessage(null);
        setDraftAnswer(null);
        setLiveTimeline([]);
      }).catch((reason: unknown) => setError(friendlyError(reason)));
    }, 30);
    return () => window.clearInterval(timer);
  }, [busy, syncState]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let state = await invoke<AppState>("load_app_state");
        let attemptedOpenCodeImport = false;
        if (!active) return;
        if (state.providers.length === 0) {
          attemptedOpenCodeImport = true;
          try {
            state = await invoke<AppState>("import_opencode_providers");
          } catch (reason) {
            state = await invoke<AppState>("load_app_state");
            if (active && state.providers.length === 0) {
              setError(`Import automatique OpenCode impossible : ${friendlyError(reason)}`);
            }
          }
        }
        if (!active) return;
        setAppState(state);
        const firstProvider = state.providers.find((provider) => provider.id === state.selectedProviderId)
          ?? state.providers[0];
        const selectedModel = firstProvider?.models.includes(state.selectedModelId ?? "")
          ? state.selectedModelId!
          : firstProvider?.models[0] ?? "";
        setProviderId(firstProvider?.id ?? "");
        setModelId(selectedModel);
        if (firstProvider && selectedModel !== state.selectedModelId) {
          state = await invoke<AppState>("set_selected_model", {
            providerId: firstProvider.id,
            modelId: selectedModel,
          });
          setAppState(state);
        }
        const initialSession = await invoke<Session>("create_chat_session", {
          projectPath: state.projectPath ?? "/home/Matthew",
          providerId: firstProvider?.id ?? "",
          modelId: selectedModel,
        });
        if (active) {
          setSessionId(initialSession.id);
          setMode("build");
          setAppState(await invoke<AppState>("load_app_state"));
        }
        const initialCatalogError = state.providers.find((provider) => provider.modelsError);
        if (initialCatalogError) {
          setError(`${initialCatalogError.name} : ${initialCatalogError.modelsError}`);
        }
        if (active && !attemptedOpenCodeImport) {
          void invoke<AppState>("import_opencode_providers")
            .then(async (updated) => {
              if (!active) return;
              setAppState(updated);
              if (!updated.providers.some(
                (provider) => provider.id === "opencode" || provider.id === "opencode-zen-free",
              )) {
                setError(
                  "Le fournisseur OpenCode Zen n’a pas pu être ajouté. Vérifie que le CLI OpenCode est accessible depuis LUCY, puis relance l’import.",
                );
              }
              const selectedProvider = updated.providers.find(
                (provider) => provider.id === updated.selectedProviderId,
              ) ?? updated.providers[0];
              const selectedModel = selectedProvider?.models.includes(updated.selectedModelId ?? "")
                ? updated.selectedModelId!
                : selectedProvider?.models[0] ?? "";
              setProviderId(selectedProvider?.id ?? "");
              setModelId(selectedModel);
              const failedProvider = updated.providers.find((provider) => provider.modelsError);
              if (failedProvider) setError(`${failedProvider.name} : ${failedProvider.modelsError}`);
              if (firstProvider && firstProvider.models.length === 0) {
                const refreshedState = await invoke<AppState>("refresh_provider_models", {
                  providerId: firstProvider.id,
                });
                if (!active) return;
                setAppState(refreshedState);
                const refreshed = refreshedState.providers.find((provider) => provider.id === firstProvider.id);
                if (refreshed?.modelsError) {
                  setError(`${refreshed.name} : ${refreshed.modelsError}`);
                }
                const nextModel = refreshed?.models.includes(refreshedState.selectedModelId ?? "")
                  ? refreshedState.selectedModelId!
                  : refreshed?.models[0] ?? "";
                if (refreshed && nextModel) {
                  setProviderId(refreshed.id);
                  setModelId(nextModel);
                  setAppState(await invoke<AppState>("set_selected_model", {
                    providerId: refreshed.id,
                    modelId: nextModel,
                  }));
                }
              }
            })
            .catch((reason: unknown) => {
              if (active) setError(`Import automatique OpenCode impossible : ${friendlyError(reason)}`);
            });
        }
        if (active && attemptedOpenCodeImport && firstProvider && firstProvider.models.length === 0) {
          void invoke<AppState>("refresh_provider_models", { providerId: firstProvider.id })
            .then(async (updated) => {
              if (!active) return;
              setAppState(updated);
              const refreshed = updated.providers.find((provider) => provider.id === firstProvider.id);
              if (refreshed?.modelsError) setError(`${refreshed.name} : ${refreshed.modelsError}`);
              const nextModel = refreshed?.models.includes(state.selectedModelId ?? "")
                ? state.selectedModelId!
                : refreshed?.models[0] ?? "";
              if (refreshed && nextModel) {
                setProviderId(refreshed.id);
                setModelId(nextModel);
                setAppState(await invoke<AppState>("set_selected_model", {
                  providerId: refreshed.id,
                  modelId: nextModel,
                }));
              }
            })
            .catch(async (reason: unknown) => {
              if (!active) return;
              setError(friendlyError(reason));
              try {
                const updated = await invoke<AppState>("load_app_state");
                setAppState(updated);
                const failedProvider = updated.providers.find((provider) => provider.id === firstProvider.id);
                if (failedProvider?.modelsError) setError(`${failedProvider.name} : ${failedProvider.modelsError}`);
              } catch (syncReason) {
                setError(friendlyError(syncReason));
              }
            });
        }
      } catch (reason) {
        if (active) setError(friendlyError(reason));
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen<ChatUpdate>("chat:update", (event) => {
      const update = event.payload;
      if (update.sessionId !== sessionId) return;
      if (update.kind === "user") {
        setDraftMessage({ id: update.messageId, role: "user", text: update.delta, createdAt: Date.now() });
      } else if (update.kind === "context") {
        setProjectContext(update.details as unknown as ProjectContext);
        setContextLoading(false);
      } else if (update.kind === "context_usage") {
        const usage = {
          modelId: String(update.details?.modelId ?? ""),
          usedTokens: Number(update.details?.usedTokens ?? 0),
          limitTokens: Number(update.details?.limitTokens ?? 0),
        };
        setAppState((previous) => ({
          ...previous,
          sessions: previous.sessions.map((session) =>
            session.id === update.sessionId ? { ...session, contextUsage: usage } : session,
          ),
        }));
      } else if (update.kind === "compacting") {
        setContextCompacting(true);
      } else if (update.kind === "compacted") {
        setContextCompacting(false);
      } else if (update.kind === "tool_start") {
        setLiveTimeline((segments) => {
          if (segments.some((segment) => segment.kind === "tool" && segment.tool.id === update.messageId)) {
            return segments;
          }
          return [...segments, {
            kind: "tool" as const,
            tool: {
            id: update.messageId,
            name: String(update.details?.name ?? "outil"),
            arguments: (update.details?.arguments as Record<string, unknown>) ?? {},
            },
          }];
        });
      } else if (update.kind === "tool_result") {
        setLiveTimeline((segments) => segments.map((segment) =>
          segment.kind === "tool" && segment.tool.id === update.messageId
            ? { ...segment, tool: { ...segment.tool, result: String(update.details?.result ?? "") } }
            : segment,
        ));
        void refreshExplorer().catch((reason: unknown) => setError(friendlyError(reason)));
      } else if (update.kind === "delta") {
        setContextCompacting(false);
        setRetryStatus(null);
        lastStreamMessageId.current = update.messageId;
        const combined = incompleteWord.current + update.delta;
        let consumed = 0;
        for (const match of combined.matchAll(/\S+\s*/g)) {
          const start = match.index ?? 0;
          const end = start + match[0].length;
          const complete = /\s$/.test(match[0]) || end < combined.length;
          if (!complete) break;
          const word = combined.slice(consumed, end);
          if (word) streamedEvents.current.push({ kind: "word", id: update.messageId, text: word });
          consumed = end;
        }
        incompleteWord.current = combined.slice(consumed);
      } else if (update.kind === "round") {
        if (incompleteWord.current) {
          streamedEvents.current.push({
            kind: "word",
            id: lastStreamMessageId.current || update.messageId,
            text: incompleteWord.current,
          });
          incompleteWord.current = "";
        }
      } else if (update.kind === "retry") {
        if (update.details?.active === false) {
          setRetryStatus(null);
        } else {
          setRetryStatus({
            attempt: Number(update.details?.attempt ?? 1),
            maxRetries: Number(update.details?.maxRetries ?? 10),
            retryAt: Date.now() + Number(update.details?.retryAfterSeconds ?? 1) * 1000,
            reason: update.error ?? "erreur temporaire",
          });
        }
      } else if (update.kind === "stopped") {
        setContextCompacting(false);
        setRetryStatus(null);
        streamedEvents.current = [];
        incompleteWord.current = "";
        streamComplete.current = false;
        setBusy(false);
        setContextLoading(false);
        setPendingApproval(null);
        setPendingQuestion(null);
        void syncState().then(() => {
          setDraftMessage(null);
          setDraftAnswer(null);
          setLiveTimeline([]);
        }).catch((reason: unknown) => setError(friendlyError(reason)));
      } else if (update.kind === "done") {
        setContextCompacting(false);
        setRetryStatus(null);
        void refreshExplorer().catch((reason: unknown) => setError(friendlyError(reason)));
        if (incompleteWord.current) {
          streamedEvents.current.push({
            kind: "word",
            id: lastStreamMessageId.current || update.messageId,
            text: incompleteWord.current,
          });
          incompleteWord.current = "";
        }
        streamComplete.current = true;
      } else if (update.kind === "error") {
        setContextCompacting(false);
        setRetryStatus(null);
        streamedEvents.current = [];
        incompleteWord.current = "";
        streamComplete.current = false;
        setError(update.error ?? "Le fournisseur a interrompu la génération.");
        setBusy(false);
        setContextLoading(false);
        void syncState().then(() => {
          setDraftMessage(null);
          setDraftAnswer(null);
          setLiveTimeline([]);
        }).catch((reason: unknown) => setError(friendlyError(reason)));
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [sessionId, syncState, refreshExplorer]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen<ToolApproval>("tool:approval", (event) => {
      setPendingApproval(event.payload);
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen<UserQuestion>("user:question", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      setPendingQuestion(event.payload);
      setQuestionAnswer("");
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [sessionId]);

  useEffect(() => {
    if (!projectPath) return;
    void syncFiles().catch((reason: unknown) => setError(friendlyError(reason)));
  }, [projectPath, syncFiles]);

  useEffect(() => {
    if (!projectPath) {
      setSkills([]);
      return;
    }
    void invoke<ProjectSkill[]>("list_project_skills", { projectPath })
      .then(setSkills)
      .catch((reason: unknown) => setError(friendlyError(reason)));
  }, [projectPath]);

  useEffect(() => {
    if (chatScrollFrame.current !== null) {
      window.cancelAnimationFrame(chatScrollFrame.current);
    }
    chatScrollFrame.current = window.requestAnimationFrame(() => {
      chatScrollFrame.current = null;
      scrollChatToBottom();
    });
    return () => {
      if (chatScrollFrame.current !== null) {
        window.cancelAnimationFrame(chatScrollFrame.current);
        chatScrollFrame.current = null;
      }
    };
  }, [sessionId, currentSession?.messages, draftMessage, draftAnswer, liveTimeline, scrollChatToBottom]);

  useEffect(() => {
    const content = chatContent.current;
    if (!content) return;
    const observer = new ResizeObserver(scrollChatToBottom);
    observer.observe(content);
    return () => observer.disconnect();
  }, [sessionId, scrollChatToBottom]);

  const chooseProject = async () => {
    if (!isTauri()) {
      setError("Ouvre LUCY depuis son application de bureau pour sélectionner un projet.");
      return;
    }
    try {
      const selection = await open({ directory: true, multiple: false, title: "Choisir un projet" });
      if (typeof selection !== "string") return;
      const updated = await invoke<AppState>("set_project_path", { projectPath: selection });
      setAppState(updated);
      setSessionId("");
      setNotice("Dossier de travail enregistré localement.");
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const openSkillsManager = async () => {
    if (!projectPath) {
      setError("Choisis un projet avant de gérer ses skills Claude Code.");
      return;
    }
    setShowSkills(true);
    try {
      setSkills(await invoke<ProjectSkill[]>("list_project_skills", { projectPath }));
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const createSkill = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectPath) return;
    setSkillsBusy(true);
    try {
      const updated = await invoke<ProjectSkill[]>("create_project_skill", {
        projectPath,
        ...skillForm,
      });
      setSkills(updated);
      setSkillForm({ name: "", description: "", instructions: "" });
      setNotice("Skill Claude Code créé dans le projet.");
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setSkillsBusy(false);
    }
  };

  const importSkill = async () => {
    if (!projectPath || !isTauri()) {
      setError("L’import d’un skill nécessite l’application de bureau.");
      return;
    }
    try {
      const sourcePath = await open({
        directory: true,
        multiple: false,
        title: "Choisir un dossier de skill Claude Code (avec SKILL.md)",
      });
      if (typeof sourcePath !== "string") return;
      setSkillsBusy(true);
      const updated = await invoke<ProjectSkill[]>("import_project_skill", {
        projectPath,
        sourcePath,
      });
      setSkills(updated);
      setNotice("Skill importé dans .claude/skills.");
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setSkillsBusy(false);
    }
  };

  const deleteSkill = async (name: string) => {
    if (!projectPath || !window.confirm(`Supprimer le skill « ${name} » de ce projet ?`)) return;
    setSkillsBusy(true);
    try {
      setSkills(await invoke<ProjectSkill[]>("delete_project_skill", { projectPath, name }));
      setNotice(`Skill « ${name} » supprimé du projet.`);
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setSkillsBusy(false);
    }
  };

  const selectSession = (id: string) => {
    stickToChatBottom.current = true;
    streamedEvents.current = [];
    incompleteWord.current = "";
    streamComplete.current = false;
    setBusy(false);
    setSessionId(id);
    setClearedChat(null);
    const selected = appState.sessions.find((session) => session.id === id);
    if (selected) {
      setProviderId(selected.providerId || appState.providers[0]?.id || "");
      setModelId(selected.modelId || appState.providers.find((provider) => provider.id === selected.providerId)?.models[0] || "");
      setMode(selected.mode ?? "build");
    }
    setDraftMessage(null);
    setDraftAnswer(null);
    setLiveTimeline([]);
    setProjectContext(null);
    setContextLoading(false);
    setPendingQuestion(null);
    setQuestionAnswer("");
    setError("");
  };

  const createSession = async (): Promise<boolean> => {
    if (!projectPath) {
      setError("Le dossier de travail par défaut est introuvable.");
      return false;
    }
    try {
      const created = await invoke<Session>("create_chat_session", {
        projectPath, providerId, modelId,
      });
      streamedEvents.current = [];
      incompleteWord.current = "";
      streamComplete.current = false;
      setBusy(false);
      setSessionId(created.id);
      stickToChatBottom.current = true;
      setDraftMessage(null);
      setDraftAnswer(null);
      setLiveTimeline([]);
      setProjectContext(null);
      setContextLoading(false);
      setMode("build");
      await syncState();
      return true;
    } catch (reason) {
      setError(friendlyError(reason));
      return false;
    }
  };

  const refreshModels = async (id = providerId) => {
    if (!id) return;
    try {
      const updated = await invoke<AppState>("refresh_provider_models", { providerId: id });
      setAppState(updated);
      const refreshed = updated.providers.find((provider) => provider.id === id);
      if (refreshed?.models[0]) {
        setProviderId(id);
        setModelId(refreshed.models[0]);
        setAppState(await invoke<AppState>("set_selected_model", {
          providerId: id,
          modelId: refreshed.models[0],
        }));
      }
      setNotice(`${refreshed?.models.length ?? 0} modèle(s) récupéré(s).`);
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
      try {
        setAppState(await invoke<AppState>("load_app_state"));
      } catch (syncReason) {
        setError(friendlyError(syncReason));
      }
    }
  };

  const selectModel = async (selection: string) => {
    const [nextProviderId, ...modelParts] = selection.split("::");
    const nextModelId = modelParts.join("::");
    setProviderId(nextProviderId);
    setModelId(nextModelId);
    try {
      setAppState(await invoke<AppState>("set_selected_model", {
        providerId: nextProviderId,
        modelId: nextModelId,
      }));
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const importProviders = async () => {
    setBusy(true);
    setError("");
    setRetryStatus(null);
    setNotice("");
    try {
      const updated = await invoke<AppState>("import_opencode_providers");
      setAppState(updated);
      const hasOpenCodeZen = updated.providers.some(
        (provider) => provider.id === "opencode" || provider.id === "opencode-zen-free",
      );
      const first = updated.providers.find((provider) => provider.id === updated.selectedProviderId)
        ?? updated.providers.find((provider) => provider.models.length > 0);
      if (first) {
        setProviderId(first.id);
        const firstModel = first.models.includes(updated.selectedModelId ?? "")
          ? updated.selectedModelId!
          : first.models[0] ?? "";
        setModelId(firstModel);
        if (firstModel) {
          const selected = await invoke<AppState>("set_selected_model", {
            providerId: first.id,
            modelId: firstModel,
          });
          setAppState(selected);
        }
      }
      const availableModels = updated.providers.reduce((count, provider) => count + provider.models.length, 0);
      setNotice(`${updated.providers.length} compte(s) importé(s), ${availableModels} modèle(s) disponible(s).`);
      const zenError = updated.providers.find(
        (provider) => provider.id === "opencode-zen-free" && provider.modelsError,
      );
      if (zenError?.modelsError) setError(`${zenError.name} : ${zenError.modelsError}`);
      else if (first && first.modelsError) setError(`${first.name} : ${first.modelsError}`);
      else if (!hasOpenCodeZen) {
        setError("Le fournisseur OpenCode Zen n’a pas pu être ajouté. Vérifie que le CLI OpenCode est accessible depuis LUCY, puis relance l’import.");
      }
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const updated = await invoke<AppState>("save_provider", {
        input: {
          ...providerForm,
          id: providerForm.id || providerForm.name,
          apiKey: providerForm.apiKey,
          models: providerForm.models.split(",").map((model) => model.trim()).filter(Boolean),
        },
      });
      const saved = updated.providers.find((provider) => provider.id === providerForm.id.toLowerCase().replaceAll(" ", "-") || provider.name === providerForm.name);
      setAppState(updated);
      setProviderId(saved?.id ?? updated.providers.at(-1)?.id ?? "");
      setShowProvider(false);
      setProviderForm((form) => ({ ...form, apiKey: "" }));
      setNotice("Fournisseur enregistré sur cet ordinateur.");
      if (saved) await refreshModels(saved.id);
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = async (id: string) => {
    if (!window.confirm("Supprimer les identifiants de ce fournisseur enregistrés par LUCY ?")) return;
    try {
      const updated = await invoke<AppState>("delete_provider", { providerId: id });
      setAppState(updated);
      setProviderId(updated.providers[0]?.id ?? "");
      setModelId(updated.providers[0]?.models[0] ?? "");
      setNotice("Identifiants supprimés de LUCY.");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const sendMessage = async (messageText?: string) => {
    const text = (messageText ?? input).trim();
    if (!text || busy || !sessionId) return;
    stickToChatBottom.current = true;
    setError("");
    setRetryStatus(null);
    setNotice("");
    if (text === "/help") {
      setNotice("/help — afficher l’aide ; /clear — effacer l’affichage sans supprimer l’historique ; /skill(s) — gérer les skills Claude Code ; /terminal — commande shell avec confirmation.");
      setInput("");
      return;
    }
    if (text === "/skills" || text === "/skill") {
      setInput("");
      await openSkillsManager();
      return;
    }
    if (text === "/terminal") {
      setInput("");
      setShowCommand(true);
      return;
    }
    if (text === "/clear") {
      setInput("");
      setDraftMessage(null);
      setDraftAnswer(null);
      setLiveTimeline([]);
      setProjectContext(null);
      setClearedChat({
        sessionId,
        messageCount: currentSession?.messages.length ?? 0,
      });
      setNotice("Affichage effacé. L’historique reste sauvegardé et visible si tu rouvres cette session.");
      return;
    }
    if (!providerId || !modelId) {
      setError("Connecte un fournisseur et sélectionne un modèle avant d’envoyer un message.");
      setShowProvider(true);
      return;
    }
    const pendingUser: ChatMessage = {
      id: `draft-${Date.now()}`, role: "user", text, createdAt: Date.now(),
    };
    setDraftMessage(pendingUser);
    setDraftAnswer({ id: `pending-${Date.now()}`, role: "assistant", text: "", createdAt: Date.now() });
    setLiveTimeline([]);
    streamedEvents.current = [];
    incompleteWord.current = "";
    lastStreamMessageId.current = "";
    streamComplete.current = false;
    setProjectContext(null);
    setContextLoading(true);
    setContextCompacting(false);
    setInput("");
    setBusy(true);
    try {
      await invoke("send_message", { sessionId, text, providerId, modelId, mode });
    } catch (reason) {
      setError(friendlyError(reason));
      setContextCompacting(false);
      streamedEvents.current = [];
      incompleteWord.current = "";
      streamComplete.current = false;
      setBusy(false);
      setContextLoading(false);
      void syncState().then(() => {
        setDraftMessage(null);
        setDraftAnswer(null);
        setLiveTimeline([]);
      }).catch((syncReason: unknown) => setError(friendlyError(syncReason)));
    }
  };

  const stopGeneration = async () => {
    if (!busy || !sessionId) return;
    try {
      await invoke("stop_generation", { sessionId });
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const openMessageMenu = (message: { id: string; text?: string }, event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMessageMenu({ messageId: message.id, text: message.text ?? "", selected: 0 });
  };

  const activateMessageMenu = async (selected: number) => {
    const item = messageMenu;
    if (!item) return;
    setMessageMenu(null);
    if (selected === 0) {
      setEditingMessageId(item.messageId);
      setEditedText(item.text);
      return;
    }
    if (selected === 1) {
      try {
        await navigator.clipboard.writeText(item.text);
        setNotice("Message copié dans le presse-papiers.");
      } catch (reason) {
        setError(`Copie impossible : ${friendlyError(reason)}`);
      }
      return;
    }
    try {
      const updated = await invoke<AppState>("truncate_session_from_message", {
        sessionId,
        messageId: item.messageId,
      });
      setAppState(updated);
      setEditingMessageId("");
      setNotice("Message et suite de la conversation supprimés.");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const saveEditedMessage = async () => {
    const text = editedText.trim();
    if (!text || !editingMessageId || busy) return;
    try {
      const updated = await invoke<AppState>("truncate_session_from_message", {
        sessionId,
        messageId: editingMessageId,
      });
      setAppState(updated);
      setEditingMessageId("");
      setInput("");
      await sendMessage(text);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  useEffect(() => {
    if (!messageMenu) return;
    messageMenuRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMessageMenu(null);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setMessageMenu((current) => current
          ? { ...current, selected: (current.selected + direction + 3) % 3 }
          : current);
      } else if (event.key === "Enter") {
        event.preventDefault();
        void activateMessageMenu(messageMenu.selected);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [messageMenu]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modalOpen) return;
      if (busy) {
        event.preventDefault();
        void stopGeneration();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [busy, modalOpen, sessionId]);

  useEffect(() => {
    if (!ready || modalOpen) return;
    const onShortcut = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandPalette("main");
        setCommandPaletteIndex(0);
      } else if (modifier && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        composerInput.current?.focus();
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createSession();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [ready, modalOpen, createSession]);

  useEffect(() => {
    if (!modalOpen) return;
    const modal = document.querySelector<HTMLElement>(
      ".modal-backdrop .modal-card, .message-menu-backdrop .message-context-menu, .command-palette",
    );
    if (!modal) return;
    const focusable = () => Array.from(modal.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ));
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const preferred = modal.querySelector<HTMLElement>(
      'input[autofocus], textarea[autofocus], select[autofocus], input:not([type="hidden"]), textarea, select, button:not(:disabled)',
    );
    preferred?.focus();
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onTab);
    return () => {
      window.removeEventListener("keydown", onTab);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [modalOpen]);

  const executeShell = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!shellCommand.trim() || !projectPath) return;
    const confirmed = window.confirm(`Exécuter cette commande dans ${projectPath} ?\n\n$ ${shellCommand}`);
    if (!confirmed) return;
    setShowCommand(false);
    setBusy(true);
    setError("");
    setDraftMessage({ id: `cmd-${Date.now()}`, role: "user", text: `$ ${shellCommand}`, createdAt: Date.now() });
    try {
      const output = await invoke<string>("run_confirmed_command", {
        projectPath, command: shellCommand.trim(),
      });
      setDraftAnswer({ id: `output-${Date.now()}`, role: "assistant", text: output || "Commande exécutée sans sortie.", createdAt: Date.now() });
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setShellCommand("");
      setBusy(false);
    }
  };

  const resolveApproval = async (approved: boolean, alwaysAllow = false) => {
    if (!pendingApproval) return;
    try {
      await invoke("resolve_tool_approval", {
        requestId: pendingApproval.id,
        approved,
        alwaysAllow: approved && alwaysAllow,
      });
      setPendingApproval(null);
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const submitQuestionAnswer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pendingQuestion || !questionAnswer.trim()) return;
    try {
      await invoke("answer_user_question", {
        questionId: pendingQuestion.id,
        answer: questionAnswer.trim(),
      });
      setPendingQuestion(null);
      setQuestionAnswer("");
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  useEffect(() => {
    const onModalEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || messageMenu) return;
      if (sessionContextMenu) {
        event.preventDefault();
        setSessionContextMenu(null);
      } else if (pendingApproval) {
        event.preventDefault();
        void resolveApproval(false);
      } else if (pendingQuestion) {
        event.preventDefault();
        void stopGeneration();
      } else if (showCommand) {
        event.preventDefault();
        setShowCommand(false);
      } else if (showSkills) {
        event.preventDefault();
        setShowSkills(false);
      } else if (showProvider) {
        event.preventDefault();
        setShowProvider(false);
      }
    };
    window.addEventListener("keydown", onModalEscape);
    return () => window.removeEventListener("keydown", onModalEscape);
  }, [messageMenu, sessionContextMenu, pendingApproval, pendingQuestion, showCommand, showSkills, showProvider, resolveApproval, stopGeneration]);

  const changeMode = async (nextMode: "build" | "plan" | "discussion") => {
    setMode(nextMode);
    if (sessionId) {
      try {
        await invoke("set_project_mode", { sessionId, mode: nextMode });
        await syncState();
      } catch (reason) {
        setError(friendlyError(reason));
      }
    }
  };

  const removeSession = async (session: Session) => {
    if (!window.confirm(`Supprimer « ${session.title} » et sa conversation ?`)) return;
    try {
      const updated = await invoke<AppState>("delete_chat_session", { sessionId: session.id });
      setAppState(updated);
      if (sessionId === session.id) selectSession("");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const activateCommandPaletteItem = (index: number) => {
    if (commandPalette === "main") {
      if (index === 0) {
        setCommandPalette("sessions");
        setCommandPaletteIndex(0);
      } else if (index === 1) {
        setCommandPalette("models");
        setCommandPaletteIndex(0);
      } else if (index === 2) {
        setCommandPalette(null);
        void createSession();
      } else if (index === 3) {
        setCommandPalette(null);
        if (currentSession) void removeSession(currentSession);
        else setError("Aucune session active à supprimer.");
      } else if (index === 4) {
        setCommandPalette(null);
        if (windowControls) {
          void windowControls.close().catch((reason: unknown) => setError(friendlyError(reason)));
        } else {
          setError("La fermeture de l’application nécessite l’application de bureau.");
        }
      } else if (index === 5) {
        setCommandPalette(null);
      }
      return;
    }

    if (commandPalette === "sessions") {
      const session = appState.sessions[index];
      if (!session) return;
      selectSession(session.id);
      setCommandPalette(null);
    } else if (commandPalette === "models") {
      const model = paletteModels[index];
      if (!model) return;
      void selectModel(`${model.providerId}::${model.modelId}`);
      setCommandPalette(null);
    }
  };

  useEffect(() => {
    if (!commandPalette) return;
    const itemCount = commandPalette === "main"
      ? commandPaletteActions.length
      : commandPalette === "sessions" ? appState.sessions.length : paletteModels.length;
    const onCommandPaletteKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (commandPalette === "main") setCommandPalette(null);
        else {
          setCommandPalette("main");
          setCommandPaletteIndex(commandPalette === "sessions" ? 0 : 1);
        }
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (itemCount > 0) {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setCommandPaletteIndex((index) => (index + direction + itemCount) % itemCount);
        }
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        activateCommandPaletteItem(commandPaletteIndex);
      }
    };
    window.addEventListener("keydown", onCommandPaletteKeyDown);
    return () => window.removeEventListener("keydown", onCommandPaletteKeyDown);
  }, [commandPalette, commandPaletteIndex, appState.sessions, paletteModels]);

  useEffect(() => {
    if (!commandPalette) return;
    const selected = document.querySelector<HTMLElement>(".command-palette-option.selected");
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: "nearest" });
  }, [commandPalette, commandPaletteIndex, appState.sessions.length, paletteModels.length]);

  const openSessionContextMenu = (event: React.MouseEvent, session: Session) => {
    event.preventDefault();
    setSessionContextMenu({
      sessionId: session.id,
      x: Math.max(8, Math.min(event.clientX, Math.max(8, window.innerWidth - 188))),
      y: Math.max(8, Math.min(event.clientY, Math.max(8, window.innerHeight - 140))),
    });
  };

  const renameSession = async (session: Session) => {
    setSessionContextMenu(null);
    const title = window.prompt("Nouveau nom de la session :", session.title);
    if (title === null || !title.trim()) return;
    try {
      const updated = await invoke<AppState>("rename_chat_session", {
        sessionId: session.id,
        title: title.trim(),
      });
      setAppState(updated);
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const loadFile = async (item: FileItem) => {
    try {
      if (item.type === "directory") {
        const items = await invoke<FileItem[]>("list_project_files", {
          projectPath, requestedPath: item.path,
        });
        setFiles(items);
        setFilePath(item.path);
        setFileContent("");
        return;
      }
      const content = await invoke<string>("read_project_file", {
        projectPath, requestedPath: item.path,
      });
      setFilePath(item.path);
      setFileContent(content);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const contextMenuSession = appState.sessions.find((session) => session.id === sessionContextMenu?.sessionId);

  const messages = [
    ...((currentSession?.messages ?? []).slice(
      clearedChat?.sessionId === sessionId ? clearedChat.messageCount : 0,
    )),
    ...(draftMessage && !currentSession?.messages.some((message) => message.id === draftMessage.id) ? [draftMessage] : []),
    ...(draftAnswer && !currentSession?.messages.some((message) => message.id === draftAnswer.id) ? [draftAnswer] : []),
  ];
  const displayMessages: { id: string; role: string; text?: string; createdAt: number; segments: TimelineSegment[] }[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      displayMessages.push({ ...message, segments: [] });
      continue;
    }
    let assistant = displayMessages.at(-1);
    if (!assistant || assistant.role === "user") {
      assistant = { id: message.id, role: "assistant", createdAt: message.createdAt, segments: [] };
      displayMessages.push(assistant);
    }
    if (message.role === "assistant") {
      if (message.text) {
        assistant.segments.push({ kind: "text", id: message.id, text: message.text });
      }
      for (const call of message.toolCalls ?? []) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch {}
        if (!assistant.segments.some((segment) => segment.kind === "tool" && segment.tool.id === call.id)) {
          assistant.segments.push({
            kind: "tool",
            tool: { id: call.id, name: call.function.name, arguments: args },
          });
        }
      }
    } else if (message.role === "tool" && message.toolCallId) {
      const tool = assistant.segments.find((segment) =>
        segment.kind === "tool" && segment.tool.id === message.toolCallId);
      if (tool?.kind === "tool") tool.tool.result = message.text;
    }
  }
  if (draftAnswer && busy) {
    let assistant = displayMessages.at(-1);
    if (!assistant || assistant.role === "user") {
      assistant = { id: draftAnswer.id, role: "assistant", createdAt: draftAnswer.createdAt, segments: [] };
      displayMessages.push(assistant);
    }
    assistant.segments.push(...liveTimeline);
  }

  return (
    <main className={`app-shell ${appState.isHyprlandSession ? "hyprland-session" : ""}`}>
      <a className="skip-link" href="#chat-composer">Aller à la zone de chat</a>
      {!appState.isHyprlandSession && <header className="titlebar" data-tauri-drag-region>
        <div className="brand-lockup" data-tauri-drag-region>
          <span className="brand-mark">L</span><span className="brand-name">LUCY</span>
        </div>
        <div className="window-controls">
          <button aria-label="Réduire" onClick={() => void windowControls?.minimize()}>−</button>
          <button aria-label="Agrandir" onClick={() => void windowControls?.toggleMaximize()}>□</button>
          <button className="close-control" aria-label="Fermer" onClick={() => void windowControls?.close()}>×</button>
        </div>
      </header>}

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div><p className="eyebrow">WORKSPACE</p><p className="project-name" title={projectPath}>{projectPath.split("/").filter(Boolean).at(-1) ?? "AUCUN PROJET"}</p></div>
            <span className={`status-dot ${ready ? "online" : ""}`} title="Moteur LUCY autonome" />
          </div>
          <button className="project-button" onClick={() => void chooseProject()}><span>⌘</span>{projectPath ? "CHANGER DE PROJET" : "OUVRIR UN PROJET"}</button>
          <button className="new-session" onClick={() => void createSession()}><span>＋</span> NOUVELLE SESSION</button>
          <button className="new-session skills-button" onClick={() => void openSkillsManager()}><span>✳</span> SKILLS CLAUDE CODE <small>{skills.length}</small></button>
          <div className="sidebar-section-title"><span>CONVERSATIONS</span><span className="count">{visibleSessions.length.toString().padStart(2, "0")}</span></div>
          <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filtrer les sessions…" /></label>
          <nav className="session-list">
            {visibleSessions.map((session) => (
              <div key={session.id} className={`session-row ${session.id === sessionId ? "selected" : ""}`} onContextMenu={(event) => openSessionContextMenu(event, session)}>
                <button className="session-select" onClick={() => selectSession(session.id)}><span className="session-glyph">›_</span><span className="session-title">{session.title}</span></button>
                <button className="session-delete" aria-label={`Supprimer la session ${session.title}`} onClick={() => void removeSession(session)}>×</button>
              </div>
            ))}
            {visibleSessions.length === 0 && <p className="empty-side">{ready ? "Aucune session pour l’instant." : "Chargement…"}</p>}
          </nav>
          <div className="sidebar-bottom">
            <div className="provider-status"><span className="status-led" /><span>{appState.providers.length} FOURNISSEUR{appState.providers.length === 1 ? "" : "S"} LOCA{appState.providers.length === 1 ? "L" : "UX"}</span></div>
            <button className="settings-button" onClick={() => setShowProvider(true)}><span>＋</span> FOURNISSEURS & MODÈLES</button>
          </div>
        </aside>

        <section className="center-pane">
          <div
            className="topbar"
            data-tauri-drag-region
            onMouseDown={(event) => {
              if (
                event.button !== 0
                || !(event.target instanceof Element)
                || event.target.closest("button, a, input, textarea, select, [role='button']")
              ) return;
              void windowControls?.startDragging().catch((reason: unknown) => setError(friendlyError(reason)));
            }}
          >
            <div className="breadcrumb"><span className="crumb-dim">LUCY</span><span className="crumb-slash">/</span><span>{currentSession?.title ?? (projectPath ? "SESSION EN ATTENTE" : "SYSTÈME HORS LIGNE")}</span></div>
            <div className="toolbar-actions" data-tauri-drag-region="false">
              <button className="icon-button" title="Nouvelle session" aria-label="Nouvelle session" onClick={() => void createSession()}>＋</button>
              <button className="icon-button" title="Terminal avec confirmation" aria-label="Ouvrir le terminal local" onClick={() => setShowCommand(true)} disabled={!projectPath}>$_</button>
            </div>
          </div>

          {(error || notice || retryStatus) && <div className={retryStatus && !error ? "error-banner retry-banner" : error ? "error-banner" : "notice-banner"} role="status" aria-live="polite"><span>{retryStatus && !error ? `${currentProvider?.name ?? "Fournisseur"} temporairement indisponible (${retryStatus.reason}). Nouvelle tentative ${retryStatus.attempt}/${retryStatus.maxRetries} dans ${Math.max(0, Math.ceil((retryStatus.retryAt - retryClock) / 1000))} s…` : error || notice}</span><button onClick={() => { setError(""); setNotice(""); }} aria-label="Fermer">×</button></div>}

          {!ready ? (
            <div className="empty-chat"><span className="empty-symbol">◌</span><p>INITIALISATION DU SYSTÈME LOCAL…</p></div>
          ) : !projectPath ? (
            <div className="welcome-screen"><div className="scanlines" /><div className="welcome-content">
              <div className="glitch-mark">L<span>.</span></div><p className="eyebrow red">LOCAL NEURAL ENGINE // 01</p>
              <h1>TON ESPACE.<br /><em>TES RÈGLES.</em></h1>
              <p className="welcome-copy">Chat IA autonome, réponses diffusées en direct et connexions de modèles conservées sur ta machine.</p>
              <button className="primary-button" onClick={() => void chooseProject()}>CHOISIR UN PROJET <span>↗</span></button>
              <p className="safety-note"><span>◆</span> LES COMMANDES SYSTÈME EXIGENT TA CONFIRMATION</p>
            </div><div className="welcome-coordinates">LOCAL INFERENCE LINK<br />WAYLAND // NO CLOUD PROXY</div></div>
          ) : !sessionId ? (
            <div className="empty-chat"><span className="empty-symbol">⌁</span><p className="eyebrow">SESSION // INITIALISATION</p><p>Préparation de ta conversation locale…</p></div>
          ) : (
            <>
              <div
                ref={chatScroll}
                className={`chat-scroll ${busy ? "is-generating" : ""}`}
                onWheel={(event) => {
                  if (event.deltaY < 0) stickToChatBottom.current = false;
                }}
                onTouchStart={(event) => {
                  touchStartY.current = event.touches[0]?.clientY ?? null;
                }}
                onTouchMove={(event) => {
                  const currentY = event.touches[0]?.clientY;
                  if (currentY !== undefined && touchStartY.current !== null && currentY > touchStartY.current) {
                    stickToChatBottom.current = false;
                  }
                  touchStartY.current = currentY ?? null;
                }}
                onTouchEnd={() => { touchStartY.current = null; }}
                onKeyDown={(event) => {
                  if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
                    stickToChatBottom.current = false;
                  }
                }}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  if (element.scrollHeight - element.scrollTop - element.clientHeight <= 64) {
                    stickToChatBottom.current = true;
                  }
                }}
              >
                <div ref={chatContent}>
                <div className="chat-meta">
                  <span>SESSION // {sessionId.slice(-8).toUpperCase()} · {mode.toUpperCase()}{currentSession?.allowAllTools ? " · AUTO SESSION" : ""}</span>
                  <details className="context-details">
                    <summary>{contextLoading ? "CHARGEMENT DU CONTEXTE…" : projectContext ? `CONTEXTE · ${projectContext.files.length} FICHIERS` : `${currentProvider?.name ?? "AUCUN MODÈLE"} // ${modelId || "À SÉLECTIONNER"}`}</summary>
                    {projectContext && <div className="context-list">
                      <strong>{projectContext.projectPath}</strong>
                      {projectContext.instructions && <p>Instructions locales chargées (AGENTS.md / Copilot).</p>}
                      {projectContext.files.map((file) => <span key={file}>{file}</span>)}
                      {projectContext.truncated && <span>… arborescence limitée à 2 000 fichiers</span>}
                    </div>}
                  </details>
                </div>
                {messages.length === 0 && <div className="starter-card"><span className="starter-icon">◈</span><h2>{currentProvider && modelId ? "Connexion directe établie." : "Choisis ton modèle."}</h2><p>{currentProvider && modelId ? "La conversation est privée, conservée localement et envoyée directement à ton fournisseur." : "Sélectionne un modèle dans la barre de saisie ou connecte un fournisseur pour commencer."}</p></div>}
                {displayMessages.map((message) => <article key={message.id} className={`message ${message.role === "user" ? "user-message" : "assistant-message"}`}>
                  <div className="message-heading"><span className="message-avatar">{message.role === "user" ? "YOU" : "L"}</span><span>{message.role === "user" ? "TOI" : "LUCY"}</span>{message.role !== "user" && busy && message.id === displayMessages.at(-1)?.id && <span className="streaming-label" aria-label="Réponse en cours"><i /><i /><i /></span>}<span className="message-time">{new Date(message.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span></div>
                  {message.role === "user"
                    ? editingMessageId === message.id
                      ? <div className="message-edit"><textarea autoFocus value={editedText} onChange={(event) => setEditedText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingMessageId(""); }} /><div><button onClick={() => setEditingMessageId("")}>ANNULER</button><button className="edit-submit" disabled={!editedText.trim() || busy} onClick={() => void saveEditedMessage()}>RENVOYER ↗</button></div></div>
                      : <div className="message-body user-message-clickable" tabIndex={0} aria-haspopup="dialog" aria-label="Actions sur ce message" onClick={(event) => openMessageMenu(message, event)} onContextMenu={(event) => openMessageMenu(message, event)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " " || (event.shiftKey && event.key === "F10")) { event.preventDefault(); openMessageMenu(message, event); } }}>{message.text}</div>
                    : message.segments.map((segment, index) => segment.kind === "text"
                      ? <div key={`${segment.id}-${index}`} className={`message-body ${busy && segment.id === lastStreamMessageId.current ? "streaming-text" : ""}`}><div className="markdown-body"><Suspense fallback={<span className="markdown-loading">{segment.text}</span>}><MarkdownResponse>{segment.text}</MarkdownResponse></Suspense></div></div>
                      : <TerminalToolActivity
                        key={segment.tool.id}
                        tool={segment.tool}
                        animate={busy && message.id === draftAnswer?.id}
                      />)}
                  {message.role !== "user" && busy && message.id === draftAnswer?.id && message.segments.length === 0 && <div className="thinking" role="status" aria-label={contextCompacting ? "Lucy condense le contexte" : "Lucy réfléchit"}>
                    <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
                  </div>}
                </article>)}
                </div>
              </div>
              <div className="composer-wrap">
                <div className={`composer ${busy ? "composer-generating" : ""} ${input.trim() ? "is-writing" : ""}`}>
                  {commandSuggestions.length > 0 && <div className="command-suggestions" id="command-suggestions" role="listbox" aria-label="Commandes locales">{commandSuggestions.map((command, index) => <button key={command.name} id={`command-option-${command.name}`} type="button" role="option" aria-selected={index === commandSuggestionIndex} className={index === commandSuggestionIndex ? "selected" : ""} onMouseEnter={() => setCommandSuggestionIndex(index)} onClick={() => { setInput(`/${command.name} `); setCommandSuggestionIndex(0); composerInput.current?.focus(); }}><span>/{command.name}</span><small>{command.description}</small></button>)}</div>}
                  <div className="terminal-header" aria-hidden="true">
                    <span className="terminal-status"><i />LUCY</span>
                    <span>{busy ? "● GÉNÉRATION EN COURS" : "● SESSION LOCALE"}</span>
                  </div>
                  <div className="terminal-input-line">
                    <span className="terminal-prompt" aria-hidden="true">❯</span>
                    <div className="terminal-editor" ref={terminalEditor}>
                      <div className="terminal-caret-mirror" ref={terminalCaretMirror} aria-hidden="true" />
                      <textarea
                        ref={composerInput}
                        id="chat-composer"
                        value={input}
                        aria-label="Message à Lucy"
                        aria-keyshortcuts="Control+K Meta+K"
                        aria-autocomplete="list"
                        aria-controls={commandSuggestions.length > 0 ? "command-suggestions" : undefined}
                        aria-expanded={commandSuggestions.length > 0}
                        aria-activedescendant={commandSuggestions.length > 0 ? `command-option-${commandSuggestions[commandSuggestionIndex]?.name}` : undefined}
                        onChange={(event) => { setInput(event.target.value); setCommandSuggestionIndex(0); }}
                        onClick={updateTerminalCursor}
                        onKeyUp={updateTerminalCursor}
                        onSelect={updateTerminalCursor}
                        onScroll={updateTerminalCursor}
                        onFocus={updateTerminalCursor}
                        onKeyDown={(event) => {
                          if (commandSuggestions.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                            event.preventDefault();
                            const direction = event.key === "ArrowDown" ? 1 : -1;
                            setCommandSuggestionIndex((index) => (index + direction + commandSuggestions.length) % commandSuggestions.length);
                          } else if (event.key === "Escape" && commandSuggestions.length > 0) {
                            event.preventDefault();
                            event.stopPropagation();
                            setInput("");
                          } else if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            const exactCommand = commandSuggestions.find((command) => input.trim() === `/${command.name}`);
                            if (exactCommand || commandSuggestions.length === 0) {
                              void sendMessage();
                            } else {
                              setInput(`/${commandSuggestions[commandSuggestionIndex]?.name ?? commandSuggestions[0].name} `);
                              setCommandSuggestionIndex(0);
                              composerInput.current?.focus();
                            }
                          } else {
                            return;
                          }
                        }}
                        placeholder="Écris ta requête…"
                        rows={2}
                      />
                      <span
                        key={terminalCursor.tick}
                        className={`terminal-cursor ${terminalCursor.visible ? "visible" : ""}`}
                        aria-hidden="true"
                        style={{ left: terminalCursor.left, top: terminalCursor.top }}
                      />
                    </div>
                  </div>
                  <div className="composer-bottom">
                    <select className="composer-select model-select" value={`${providerId}::${modelId}`} aria-label="Modèle d’IA" disabled={busy || appState.providers.length === 0} onChange={(event) => void selectModel(event.target.value)}>
                      {appState.providers.flatMap((provider) => provider.models.map((model) =>
                        <option key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{provider.name} / {model}</option>,
                      ))}
                      {appState.providers.length > 0 && appState.providers.every((provider) => provider.models.length === 0) && <option value={`${providerId}::`}>Aucun modèle — actualise le fournisseur</option>}
                      {appState.providers.length === 0 && <option value="">Connecter un modèle…</option>}
                    </select>
                    <select className="composer-select agent-select" value={mode} aria-label="Mode de conversation" disabled={busy} onChange={(event) => void changeMode(event.target.value as "build" | "plan" | "discussion")}>
                      <option value="build">BUILD</option>
                      <option value="plan">PLAN</option>
                      <option value="discussion">DISCUSSION</option>
                    </select>
                    {input.trim() && <span className="typing-indicator" aria-label="Saisie en cours"><i /><i /><i /><i /></span>}
                    {contextUsage && <div className="context-meter-wrap">
                      <button
                        className={`context-meter ${contextPercent >= 85 ? "context-meter-high" : ""}`}
                        type="button"
                        aria-label={`Utilisation estimée du contexte : ${contextPercent} %`}
                        aria-expanded={contextMeterOpen}
                        title="Afficher l’utilisation estimée du contexte"
                        onClick={() => setContextMeterOpen((open) => !open)}
                      >
                        <svg viewBox="0 0 36 36" aria-hidden="true">
                          <circle className="context-meter-track" cx="18" cy="18" r="15.5" pathLength="100" />
                          <circle className="context-meter-fill" cx="18" cy="18" r="15.5" pathLength="100" style={{ strokeDasharray: `${contextPercent} 100` }} />
                        </svg>
                        <span>{contextPercent}</span>
                      </button>
                      {contextMeterOpen && <div className="context-meter-popover" role="status">
                        <strong>{contextPercent}% DU CONTEXTE</strong>
                        <span>~{contextUsage.usedTokens.toLocaleString("fr-FR")} / {contextUsage.limitTokens.toLocaleString("fr-FR")} tokens</span>
                        <small>Estimation du contexte envoyé. La limite réelle et le décompte peuvent varier selon le fournisseur.</small>
                      </div>}
                    </div>}
                    {busy
                      ? <button className="send-button stop-button" onClick={() => void stopGeneration()} aria-label="Arrêter la réponse" title="Arrêter la réponse"><span className="stop-square" /></button>
                      : <button className="send-button" onClick={() => void sendMessage()} disabled={!input.trim()}>ENVOYER ↗</button>}
                  </div>
                  {!appState.providers.length && <button className="connect-inline" onClick={() => setShowProvider(true)}>＋ CONNECTER UN MODÈLE</button>}
                  <div className="terminal-footer">
                    <span><kbd>ENTER</kbd> ENVOYER</span>
                    <span>{currentProvider?.name.toUpperCase() ?? "AUCUN FOURNISSEUR"} <i /> {modelId || "CHOISIR UN MODÈLE"}</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        {projectPath && <aside className="inspector">
          <div className="inspector-tabs">
            {(["files", "sessions", "mcp"] as const).map((tab) => <button key={tab} className={activePanel === tab ? "active" : ""} onClick={() => setActivePanel(tab)}>{tab === "files" ? "FICHIERS" : tab === "sessions" ? "STATS" : "MCP"}</button>)}
          </div>
          {activePanel === "files" && <div className="inspector-content"><div className="panel-title"><span>EXPLORATEUR LOCAL</span><button aria-label="Actualiser l’explorateur de fichiers" onClick={() => void refreshExplorer().catch((reason: unknown) => setError(friendlyError(reason)))}>↻</button></div><div className="current-path" title={filePath}>{filePath.replace(projectPath, "~") || "~"}</div>
            {!fileContent && <label className="hidden-files-toggle"><input type="checkbox" checked={showHiddenFiles} onChange={(event) => setShowHiddenFiles(event.target.checked)} /><span className="hidden-files-check" /><span>Afficher les fichiers cachés</span></label>}
            {fileContent ? <div className="file-preview"><button onClick={() => setFileContent("")}>← RETOUR</button><pre>{fileContent}</pre></div> : <div className="file-tree">{filePath !== projectPath && <button className="parent-folder" onClick={() => { const parent = filePath.split("/").slice(0, -1).join("/") || projectPath; void invoke<FileItem[]>("list_project_files", { projectPath, requestedPath: parent }).then((items) => { setFiles(items); setFilePath(parent); setError(""); }).catch((reason: unknown) => setError(friendlyError(reason))); }}>‹ DOSSIER PARENT</button>}{visibleFiles.map((file) => <button key={file.path} className={`file-row ${file.type === "directory" ? "directory" : "file"}`} onClick={() => void loadFile(file)} title={file.name}><span className="file-row-icon">{file.type === "directory" ? "▸" : "·"}</span><span className="file-row-name">{file.name}</span>{file.type === "directory" && <span className="file-row-chevron">›</span>}</button>)}{visibleFiles.length === 0 && <p className="file-tree-empty">{showHiddenFiles ? "Ce dossier est vide." : "Aucun élément visible dans ce dossier."}</p>}</div>}
            <button className="utility-button" onClick={() => setShowCommand(true)}>$_ TERMINAL (CONFIRMATION REQUISE)</button>
          </div>}
          {activePanel === "sessions" && <div className="inspector-content"><div className="panel-title"><span>STATISTIQUES LOCALES</span></div><p className="empty-side">Cette version autonome ne facture et ne transmet aucun compteur de tokens à un serveur LUCY.</p><p className="current-path">{appState.sessions.length} sessions sauvegardées en local</p><p className="current-path">{currentSession?.messages.length ?? 0} messages dans cette session</p></div>}
          {activePanel === "mcp" && <div className="inspector-content"><div className="panel-title"><span>PROTOCOLE MCP</span></div><p className="empty-side">Les connexions MCP sont disponibles uniquement si le serveur MCP est exposé en API compatible avec le fournisseur. Configuration MCP directe : prévue pour une prochaine version.</p></div>}
        </aside>}
      </section>

      <footer className="statusbar"><div><span className={`status-dot ${ready ? "online" : ""}`} />{ready ? "MOTEUR AUTONOME ACTIF" : "INITIALISATION…"}</div><div className="status-right"><span>{appState.providers.length} FOURNISSEUR{appState.providers.length === 1 ? "" : "S"}</span><span>IDENTIFIANTS LOCAUX</span><span>v0.2.0</span></div></footer>

      {commandPalette && <div className="command-palette-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setCommandPalette(null);
      }}>
        <section className="command-palette" role="dialog" aria-modal="true" aria-label="Navigation LUCY" tabIndex={-1}>
          <header className="command-palette-header">
            <div>
              <span className="command-palette-kicker">LUCY // NAVIGATION</span>
              <h2>{commandPalette === "main" ? "Que veux-tu faire ?" : commandPalette === "sessions" ? "Changer de session" : "Sélectionner un modèle"}</h2>
            </div>
            {commandPalette !== "main" && <button type="button" className="command-palette-back" onClick={() => {
              setCommandPalette("main");
              setCommandPaletteIndex(commandPalette === "sessions" ? 0 : 1);
            }}>← RETOUR</button>}
          </header>
          <div className={`command-palette-list ${commandPalette !== "main" ? "is-scrollable" : ""}`} role="listbox" aria-label={commandPalette === "main" ? "Actions disponibles" : commandPalette === "sessions" ? "Sessions disponibles" : "Modèles disponibles"}>
            {commandPalette === "main" && commandPaletteActions.map((action, index) => <button
              key={action.label}
              type="button"
              role="option"
              aria-selected={commandPaletteIndex === index}
              className={`command-palette-option ${commandPaletteIndex === index ? "selected" : ""}`}
              onMouseEnter={() => setCommandPaletteIndex(index)}
              onClick={() => activateCommandPaletteItem(index)}
            >
              <span className="command-palette-option-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="command-palette-option-copy"><strong>{action.label}</strong><small>{action.description}</small></span>
              <kbd>{action.shortcut}</kbd>
            </button>)}
            {commandPalette === "sessions" && appState.sessions.map((session, index) => <button
              key={session.id}
              type="button"
              role="option"
              aria-selected={commandPaletteIndex === index}
              className={`command-palette-option ${commandPaletteIndex === index ? "selected" : ""}`}
              onMouseEnter={() => setCommandPaletteIndex(index)}
              onClick={() => activateCommandPaletteItem(index)}
            >
              <span className="command-palette-option-index">{session.id === sessionId ? "●" : "○"}</span>
              <span className="command-palette-option-copy"><strong>{session.title}</strong><small>{session.projectPath}</small></span>
              <kbd>{new Date(session.updatedAt).toLocaleDateString("fr-FR")}</kbd>
            </button>)}
            {commandPalette === "sessions" && appState.sessions.length === 0 && <p className="command-palette-empty">Aucune session enregistrée.</p>}
            {commandPalette === "models" && paletteModels.map((model, index) => <button
              key={`${model.providerId}::${model.modelId}`}
              type="button"
              role="option"
              aria-selected={commandPaletteIndex === index}
              className={`command-palette-option ${commandPaletteIndex === index ? "selected" : ""}`}
              onMouseEnter={() => setCommandPaletteIndex(index)}
              onClick={() => activateCommandPaletteItem(index)}
            >
              <span className="command-palette-option-index">{model.providerId === providerId && model.modelId === modelId ? "●" : "○"}</span>
              <span className="command-palette-option-copy"><strong>{model.label}</strong><small>{model.providerId}</small></span>
              <kbd>↵</kbd>
            </button>)}
            {commandPalette === "models" && paletteModels.length === 0 && <p className="command-palette-empty">Aucun modèle disponible. Connecte ou actualise un fournisseur.</p>}
          </div>
          <footer className="command-palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> NAVIGUER</span><span><kbd>ENTER</kbd> VALIDER</span><span><kbd>ESC</kbd> FERMER / RETOUR</span></footer>
        </section>
      </div>}

      {sessionContextMenu && contextMenuSession && <div className="session-context-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSessionContextMenu(null);
      }} onContextMenu={(event) => event.preventDefault()}>
        <div className="session-context-menu" role="menu" aria-label={`Actions pour ${contextMenuSession.title}`} style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}>
          <div className="session-context-heading">SESSION</div>
          <button role="menuitem" onClick={() => { selectSession(contextMenuSession.id); setSessionContextMenu(null); }}><span>↗</span> Ouvrir</button>
          <button role="menuitem" onClick={() => void renameSession(contextMenuSession)}><span>✎</span> Renommer</button>
          <div className="session-context-divider" />
          <button className="danger" role="menuitem" onClick={() => { setSessionContextMenu(null); void removeSession(contextMenuSession); }}><span>×</span> Supprimer</button>
        </div>
      </div>}

      {messageMenu && <div className="message-menu-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setMessageMenu(null);
      }}>
        <div
          ref={messageMenuRef}
          className="message-context-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Actions sur le message"
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="message-menu-heading">ACTIONS SUR LE MESSAGE</div>
          {["Modifier le message", "Copier", "Annuler"].map((label, index) => <button
            key={label}
            role="button"
            className={messageMenu.selected === index ? "selected" : ""}
            disabled={busy && index !== 1}
            onMouseEnter={() => setMessageMenu((current) => current ? { ...current, selected: index } : current)}
            onClick={() => void activateMessageMenu(index)}
          >{label}{index === 2 && <span>SUPPRIMER</span>}</button>)}
        </div>
      </div>}

      {showProvider && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowProvider(false); }}>
        <div className="modal-card">
          <div className="modal-kicker">CONNEXIONS // CONFIGURATION LOCALE</div><button className="modal-close" aria-label="Fermer les fournisseurs et modèles" onClick={() => setShowProvider(false)}>×</button><h2>Choisir ton modèle.</h2>
          <p>Importe tes clés API OpenCode ou connecte une API compatible OpenAI — notamment Ollama, sans connexion cloud.</p>
          <button className="primary-button modal-submit" disabled={busy} onClick={() => void importProviders()}>{busy ? "IMPORT EN COURS…" : "↻ IMPORTER AUTOMATIQUEMENT LES COMPTES EXISTANTS"}</button>
          {appState.providers.map((provider) => <div className="provider-card" key={provider.id}><div><strong>{provider.name}</strong><small>{provider.baseUrl} · {provider.models.length} modèle(s) · {provider.source === "opencode-free" ? "gratuit via OpenCode local · outils activés selon le mode" : provider.source === "oauth" ? "OAuth importé" : provider.source === "import" ? "importé depuis OpenCode" : "configuré localement"}</small>{provider.modelsError && <small className="provider-error">{provider.modelsError}</small>}</div><div className="provider-actions"><button onClick={() => { setProviderId(provider.id); void refreshModels(provider.id); }}>MODÈLES ↻</button><button className="remove-provider" onClick={() => void deleteProvider(provider.id)}>×</button></div></div>)}
          <form onSubmit={(event) => void saveProvider(event)} className="provider-form">
            <label className="field-label">NOM DE LA CONNEXION</label><input value={providerForm.name} onChange={(event) => setProviderForm((form) => ({ ...form, name: event.target.value, id: form.id || event.target.value.toLowerCase().replaceAll(" ", "-") }))} placeholder="Ollama local, OpenAI…" required />
            <label className="field-label">BASE URL (OPENAI-COMPATIBLE)</label><input value={providerForm.baseUrl} onChange={(event) => setProviderForm((form) => ({ ...form, baseUrl: event.target.value }))} placeholder="http://127.0.0.1:11434/v1" required />
            <label className="field-label">CLÉ API <span className="field-optional">(LAISSER VIDE POUR OLLAMA LOCAL)</span></label><input type="password" autoComplete="off" value={providerForm.apiKey} onChange={(event) => setProviderForm((form) => ({ ...form, apiKey: event.target.value }))} placeholder="Optionnelle avec un serveur local" />
            <label className="field-label">MODÈLES (FACULTATIF, SÉPARÉS PAR DES VIRGULES)</label><input value={providerForm.models} onChange={(event) => setProviderForm((form) => ({ ...form, models: event.target.value }))} placeholder="ollama list pour Ollama, ou vide pour détecter automatiquement" />
            <button className="approve-button provider-save" disabled={busy}>AJOUTER / ENREGISTRER LE FOURNISSEUR ↗</button>
          </form>
          <span className="modal-foot">CLÉS STOCKÉES EN LOCAL, FICHIER PROTÉGÉ EN 0600. CONNEXION DIRECTE AU FOURNISSEUR.</span>
        </div>
      </div>}

      {showSkills && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSkills(false); }}>
        <div className="modal-card skills-modal">
          <div className="modal-kicker">CLAUDE CODE // SKILLS DU PROJET</div><button className="modal-close" aria-label="Fermer les skills" onClick={() => setShowSkills(false)}>×</button><h2>Skills du projet.</h2>
          <p>Les skills suivent le format Claude Code dans <code>.claude/skills/&lt;nom&gt;/SKILL.md</code>. LUCY charge leurs instructions pour chaque modèle connecté.</p>
          <div className="skills-list">
            {skills.map((skill) => <div className="skill-card" key={skill.name}>
              <div><strong>{skill.name}</strong><small>{skill.description || "Aucune description"}</small></div>
              <button className="remove-provider" aria-label={`Supprimer le skill ${skill.name}`} disabled={skillsBusy || busy} onClick={() => void deleteSkill(skill.name)}>×</button>
            </div>)}
            {skills.length === 0 && <p className="empty-side">Aucun skill dans ce projet. Crée-en un ou importe un dossier existant.</p>}
          </div>
          <button className="primary-button modal-submit" disabled={skillsBusy || busy} onClick={() => void importSkill()}>{skillsBusy ? "IMPORT EN COURS…" : "↥ IMPORTER UN DOSSIER DE SKILL"}</button>
          <form onSubmit={(event) => void createSkill(event)} className="provider-form">
            <label className="field-label">NOM DU SKILL (MINUSCULES ET TIRETS)</label><input value={skillForm.name} onChange={(event) => setSkillForm((form) => ({ ...form, name: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) }))} placeholder="revue-de-code" required />
            <label className="field-label">DESCRIPTION</label><input value={skillForm.description} onChange={(event) => setSkillForm((form) => ({ ...form, description: event.target.value }))} placeholder="Quand utiliser ce skill et ce qu’il apporte" maxLength={1024} required />
            <label className="field-label">INSTRUCTIONS</label><textarea className="skill-instructions" value={skillForm.instructions} onChange={(event) => setSkillForm((form) => ({ ...form, instructions: event.target.value }))} placeholder="Décris les consignes que le modèle doit suivre…" required />
            <button className="approve-button provider-save" disabled={skillsBusy || busy}>CRÉER LE SKILL ↗</button>
          </form>
          <span className="modal-foot">CONTENU INJECTÉ DANS LE CONTEXTE SYSTÈME, QUEL QUE SOIT LE MODÈLE.</span>
        </div>
      </div>}

      {showCommand && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCommand(false); }}>
        <form className="modal-card command-modal" onSubmit={(event) => void executeShell(event)}>
          <div className="modal-kicker">SHELL // EXÉCUTION LOCALE</div><button type="button" className="modal-close" aria-label="Fermer le terminal" onClick={() => setShowCommand(false)}>×</button><h2>Commande système.</h2>
          <p>Vérifie la commande avant de la confirmer. Elle sera exécutée dans le répertoire de ton projet.</p>
          <label className="field-label">RÉPERTOIRE DE TRAVAIL</label><code className="workspace-path">{projectPath}</code>
          <label className="field-label">COMMANDE</label><input autoFocus value={shellCommand} onChange={(event) => setShellCommand(event.target.value)} placeholder="git status" required />
          <div className="modal-actions"><button className="reject-button" type="button" onClick={() => setShowCommand(false)}>ANNULER</button><button className="approve-button">CONFIRMER ET EXÉCUTER ↗</button></div>
        </form>
      </div>}

      {pendingApproval && <div className="modal-backdrop approval-backdrop">
        <section className="modal-card approval-modal" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
          <div className="modal-kicker">AUTORISATION // ACTION DE L’AGENT</div>
          <h2 id="approval-title">Confirmer cette action ?</h2>
          <p>L’agent demande l’autorisation d’effectuer une action locale dans <code className="workspace-path">{pendingApproval.projectPath}</code>. Elle ne sera exécutée qu’une seule fois.</p>
          <label className="field-label">{pendingApproval.toolName === "run_shell" ? "COMMANDE À EXÉCUTER" : "FICHIER À MODIFIER"}</label>
          <pre className="approval-details">{pendingApproval.toolName === "run_shell"
            ? String(pendingApproval.arguments.command ?? "")
            : `${String(pendingApproval.arguments.path ?? "")}\n\n${String(pendingApproval.arguments.content ?? "")}`}</pre>
          <div className="modal-actions">
            <button className="reject-button" onClick={() => void resolveApproval(false)}>REFUSER</button>
            <button className="approve-button" onClick={() => void resolveApproval(true)}>AUTORISER UNE FOIS ↗</button>
            {!currentSession?.allowAllTools && <button className="approve-session-button" onClick={() => void resolveApproval(true, true)}>TOUT AUTORISER POUR CETTE SESSION</button>}
          </div>
          <span className="modal-foot">L’AUTORISATION DE SESSION RESTE ACTIVE UNIQUEMENT POUR CETTE CONVERSATION.</span>
        </section>
      </div>}

      {pendingQuestion && <div className="modal-backdrop approval-backdrop">
        <form className="modal-card question-modal" onSubmit={(event) => void submitQuestionAnswer(event)} role="dialog" aria-modal="true" aria-labelledby="question-title">
          <div className="modal-kicker">PRÉCISION // LUCY A BESOIN DE TON AVIS</div>
          <h2 id="question-title">{pendingQuestion.question}</h2>
          <p>Ta réponse permettra à Lucy de poursuivre sans faire de suppositions.</p>
          {pendingQuestion.options.length > 0 && <div className="question-options">
            {pendingQuestion.options.map((option) => <button
              key={option}
              type="button"
              className={questionAnswer === option ? "selected" : ""}
              onClick={() => setQuestionAnswer(option)}
            >{option}</button>)}
          </div>}
          <label className="field-label" htmlFor="question-answer">{pendingQuestion.options.length > 0 ? "CHOISIS OU ÉCRIS TA RÉPONSE" : "TA RÉPONSE"}</label>
          <textarea id="question-answer" autoFocus value={questionAnswer} onChange={(event) => setQuestionAnswer(event.target.value)} maxLength={2_000} rows={3} required />
          <div className="modal-actions">
            <button className="reject-button" type="button" onClick={() => void stopGeneration()}>ARRÊTER</button>
            <button className="approve-button" type="submit" disabled={!questionAnswer.trim()}>RÉPONDRE ET CONTINUER ↗</button>
          </div>
        </form>
      </div>}
    </main>
  );
}

export default App;
