import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  | { kind: "word"; id: string; text: string }
  | { kind: "tool_start"; tool: ToolActivity }
  | { kind: "tool_result"; id: string; result: string };
type ProjectContext = { projectPath: string; files: string[]; instructions: string; truncated: boolean };
type ProjectSkill = { name: string; description: string };
type ToolApproval = {
  id: string;
  sessionId: string;
  projectPath: string;
  toolName: string;
  arguments: Record<string, unknown>;
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
  userName: string | null;
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
const localCommands = [
  { name: "help", description: "Afficher les commandes locales" },
  { name: "clear", description: "Effacer l’affichage sans supprimer l’historique" },
  { name: "skill", description: "Gérer les skills Claude Code du projet" },
  { name: "skills", description: "Gérer les skills Claude Code du projet" },
  { name: "terminal", description: "Ouvrir un terminal local avec confirmation" },
];

const friendlyError = (error: unknown) => error instanceof Error ? error.message : String(error);

function App() {
  const [appState, setAppState] = useState<AppState>({
    projectPath: null, providers: [], sessions: [], selectedProviderId: null, selectedModelId: null, userName: null,
  });
  const [sessionId, setSessionId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<"build" | "plan" | "discussion">("build");
  const [input, setInput] = useState("");
  const [draftMessage, setDraftMessage] = useState<ChatMessage | null>(null);
  const [draftAnswer, setDraftAnswer] = useState<ChatMessage | null>(null);
  const [clearedChat, setClearedChat] = useState<{ sessionId: string; messageCount: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageMenu | null>(null);
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
  const [filePath, setFilePath] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [showProvider, setShowProvider] = useState(false);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [userNameInput, setUserNameInput] = useState("");
  const [savingUserName, setSavingUserName] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillForm, setSkillForm] = useState({ name: "", description: "", instructions: "" });
  const [providerForm, setProviderForm] = useState({
    id: "", name: "", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", models: "",
  });
  const [showCommand, setShowCommand] = useState(false);
  const [shellCommand, setShellCommand] = useState("");
  const [pendingApproval, setPendingApproval] = useState<ToolApproval | null>(null);
  const [liveTimeline, setLiveTimeline] = useState<TimelineSegment[]>([]);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextCompacting, setContextCompacting] = useState(false);
  const [contextMeterOpen, setContextMeterOpen] = useState(false);
  const chatScroll = useRef<HTMLDivElement>(null);
  const messageMenuRef = useRef<HTMLDivElement>(null);
  const stickToChatBottom = useRef(true);
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
  const currentUserName = appState.userName?.trim() ?? "";
  const visibleSessions = useMemo(
    () => appState.sessions.filter((session) => session.title.toLowerCase().includes(search.toLowerCase())),
    [appState.sessions, search],
  );
  const commandSuggestions = input.startsWith("/")
    ? localCommands.filter((command) => command.name.startsWith(input.slice(1).split(/\s+/)[0].toLowerCase())).slice(0, 5)
    : [];

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

  useEffect(() => {
    if (ready && !currentUserName) setShowNameDialog(true);
    if (currentUserName) setUserNameInput(currentUserName);
  }, [currentUserName, ready]);

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
      if (nextEvent?.kind === "tool_start") {
        setLiveTimeline((segments) => [...segments, { kind: "tool", tool: nextEvent.tool }]);
        return;
      }
      if (nextEvent?.kind === "tool_result") {
        setLiveTimeline((segments) => segments.map((segment) =>
          segment.kind === "tool" && segment.tool.id === nextEvent.id
            ? { ...segment, tool: { ...segment.tool, result: nextEvent.result } }
            : segment,
        ));
        return;
      }
      if (!streamComplete.current || streamedEvents.current.length > 0) return;
      streamComplete.current = false;
      setBusy(false);
      setContextLoading(false);
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
        let importedAtStartup = false;
        if (!active) return;
        if (state.providers.length === 0) {
          try {
            state = await invoke<AppState>("import_opencode_providers");
            importedAtStartup = true;
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
        const hasImportedOpenCodeProvider = state.providers.some(
          (provider) => provider.source === "oauth" || provider.source === "import",
        );
        const initialCatalogError = state.providers.find((provider) => provider.modelsError);
        if (initialCatalogError) {
          setError(`${initialCatalogError.name} : ${initialCatalogError.modelsError}`);
        }
        if (active && hasImportedOpenCodeProvider && !importedAtStartup) {
          void invoke<AppState>("import_opencode_providers")
            .then((updated) => {
              if (!active) return;
              setAppState(updated);
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
            })
            .catch((reason: unknown) => {
              if (active) setError(`Import automatique OpenCode impossible : ${friendlyError(reason)}`);
            });
        }
        if (active && firstProvider && firstProvider.models.length === 0 && !hasImportedOpenCodeProvider) {
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
        streamedEvents.current.push({
          kind: "tool_start",
          tool: {
            id: update.messageId,
            name: String(update.details?.name ?? "outil"),
            arguments: (update.details?.arguments as Record<string, unknown>) ?? {},
          },
        });
      } else if (update.kind === "tool_result") {
        streamedEvents.current.push({
          kind: "tool_result",
          id: update.messageId,
          result: String(update.details?.result ?? ""),
        });
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
        void syncState().then(() => {
          setDraftMessage(null);
          setDraftAnswer(null);
          setLiveTimeline([]);
        }).catch((reason: unknown) => setError(friendlyError(reason)));
      } else if (update.kind === "done") {
        setContextCompacting(false);
        setRetryStatus(null);
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
    const container = chatScroll.current;
    if (container && stickToChatBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [sessionId, currentSession?.messages, draftMessage, draftAnswer, liveTimeline]);

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

  const saveUserName = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingUserName(true);
    try {
      const updated = await invoke<AppState>("set_user_name", { userName: userNameInput });
      setAppState(updated);
      setShowNameDialog(false);
      setNotice(`C’est noté, ${updated.userName}.`);
      setError("");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setSavingUserName(false);
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
      if (first && first.modelsError) setError(`${first.name} : ${first.modelsError}`);
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

  const openMessageMenu = (message: { id: string; text?: string }, event: React.MouseEvent) => {
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
      if (messageMenu) return;
      if (busy) {
        event.preventDefault();
        void stopGeneration();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [busy, messageMenu, sessionId]);

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
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand-lockup" data-tauri-drag-region>
          <span className="brand-mark">L</span><span className="brand-name">LUCY</span>
        </div>
        <div className="window-controls">
          <button aria-label="Réduire" onClick={() => void windowControls?.minimize()}>−</button>
          <button aria-label="Agrandir" onClick={() => void windowControls?.toggleMaximize()}>□</button>
          <button className="close-control" aria-label="Fermer" onClick={() => void windowControls?.close()}>×</button>
        </div>
      </header>

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
              <div key={session.id} className={`session-row ${session.id === sessionId ? "selected" : ""}`}>
                <button className="session-select" onClick={() => selectSession(session.id)}><span className="session-glyph">›_</span><span className="session-title">{session.title}</span></button>
                <button className="session-delete" aria-label="Supprimer la session" onClick={() => void removeSession(session)}>×</button>
              </div>
            ))}
            {visibleSessions.length === 0 && <p className="empty-side">{ready ? "Aucune session pour l’instant." : "Chargement…"}</p>}
          </nav>
          <div className="sidebar-bottom">
            <div className="provider-status"><span className="status-led" /><span>{appState.providers.length} FOURNISSEUR{appState.providers.length === 1 ? "" : "S"} LOCAL{appState.providers.length === 1 ? "" : "AUX"}</span></div>
            <button className="settings-button" onClick={() => setShowNameDialog(true)}><span>◉</span> TON NOM · {currentUserName || "À CONFIGURER"}</button>
            <button className="settings-button" onClick={() => setShowProvider(true)}><span>＋</span> FOURNISSEURS & MODÈLES</button>
          </div>
        </aside>

        <section className="center-pane">
          <div className="topbar">
            <div className="breadcrumb"><span className="crumb-dim">LUCY</span><span className="crumb-slash">/</span><span>{currentSession?.title ?? (projectPath ? "SESSION EN ATTENTE" : "SYSTÈME HORS LIGNE")}</span></div>
            <div className="toolbar-actions">
              <button className="icon-button" title="Nouvelle session" onClick={() => void createSession()}>＋</button>
              <button className="icon-button" title="Terminal avec confirmation" onClick={() => setShowCommand(true)} disabled={!projectPath}>$_</button>
            </div>
          </div>

          {(error || notice || retryStatus) && <div className={retryStatus && !error ? "error-banner retry-banner" : error ? "error-banner" : "notice-banner"} role="status" aria-live="polite"><span>{retryStatus && !error ? `${currentProvider?.name ?? "Fournisseur"} temporairement indisponible (${retryStatus.reason}). Nouvelle tentative ${retryStatus.attempt}/${retryStatus.maxRetries} dans ${Math.max(0, Math.ceil((retryStatus.retryAt - retryClock) / 1000))} s…` : error || notice}</span><button onClick={() => { setError(""); setNotice(""); }} aria-label="Fermer">×</button></div>}

          {showNameDialog && <div className="modal-backdrop profile-backdrop">
            <form className="modal-card profile-modal" onSubmit={(event) => void saveUserName(event)}>
              <div className="modal-kicker">LUCY // ENTRE NOUS</div>
              {currentUserName && <button type="button" className="modal-close" onClick={() => setShowNameDialog(false)}>×</button>}
              <h2>Comment tu t’appelles ?</h2>
              <p>Je garde ton prénom uniquement sur cet ordinateur. Comme ça, je peux te parler plus naturellement.</p>
              <label className="field-label" htmlFor="user-name">TON PRÉNOM OU SURNOM</label>
              <input id="user-name" autoFocus autoComplete="given-name" value={userNameInput} onChange={(event) => setUserNameInput(event.target.value)} placeholder="Prénom ou surnom" maxLength={60} required />
              <button className="approve-button provider-save" disabled={savingUserName || !userNameInput.trim()}>{savingUserName ? "ENREGISTREMENT…" : "C’EST NOTÉ ↗"}</button>
              <span className="modal-foot">STOCKAGE LOCAL · MODIFIABLE À TOUT MOMENT</span>
            </form>
          </div>}

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
                onScroll={(event) => {
                  const element = event.currentTarget;
                  stickToChatBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 64;
                }}
              >
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
                  <div className="message-heading"><span className="message-avatar">{message.role === "user" ? "YOU" : "L"}</span><span>{message.role === "user" ? "TOI" : "LUCY"}</span><span className="message-time">{new Date(message.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span></div>
                  {message.role === "user"
                    ? editingMessageId === message.id
                      ? <div className="message-edit"><textarea autoFocus value={editedText} onChange={(event) => setEditedText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingMessageId(""); }} /><div><button onClick={() => setEditingMessageId("")}>ANNULER</button><button className="edit-submit" disabled={!editedText.trim() || busy} onClick={() => void saveEditedMessage()}>RENVOYER ↗</button></div></div>
                      : <div className="message-body user-message-clickable" onClick={(event) => openMessageMenu(message, event)} onContextMenu={(event) => openMessageMenu(message, event)}>{message.text}</div>
                    : message.segments.map((segment, index) => segment.kind === "text"
                      ? <div key={`${segment.id}-${index}`} className="message-body">{segment.text}</div>
                      : <details key={segment.tool.id} className={`tool-activity ${segment.tool.result !== undefined ? "complete" : ""}`} open>
                        <summary><span>{segment.tool.result !== undefined ? "✓" : "◌"}</span>{segment.tool.name}</summary>
                        <pre>{segment.tool.name === "run_shell" ? String(segment.tool.arguments.command ?? "") : JSON.stringify(segment.tool.arguments, null, 2)}</pre>
                        {segment.tool.result?.trim() && <pre className="tool-result">{segment.tool.result}</pre>}
                      </details>)}
                  {message.role !== "user" && busy && message.id === draftAnswer?.id && message.segments.length === 0 && <div className="thinking"><span className="pulse" /> {contextCompacting ? "LUCY CONDENSE LE CONTEXTE…" : "LUCY RÉPOND…"}</div>}
                </article>)}
              </div>
              <div className="composer-wrap">
                <div className="composer-shortcuts"><span>ENTER POUR ENVOYER</span><span>{busy ? "GÉNÉRATION EN COURS" : `${currentProvider?.name.toUpperCase() ?? "MODÈLE NON CONNECTÉ"} // ${modelId || "CHOISIR UN MODÈLE"}`}</span></div>
                <div className={`composer ${busy ? "composer-generating" : ""}`}>
                  {commandSuggestions.length > 0 && <div className="command-suggestions">{commandSuggestions.map((command) => <button key={command.name} onClick={() => setInput(`/${command.name} `)}><span>/{command.name}</span><small>{command.description}</small></button>)}</div>}
                  <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Écris un message à Lucy…" rows={2} />
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
                    <span className="composer-hint">SHIFT + ENTER POUR UNE NOUVELLE LIGNE</span>
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
                </div>
              </div>
            </>
          )}
        </section>

        {projectPath && <aside className="inspector">
          <div className="inspector-tabs">
            {(["files", "sessions", "mcp"] as const).map((tab) => <button key={tab} className={activePanel === tab ? "active" : ""} onClick={() => setActivePanel(tab)}>{tab === "files" ? "FICHIERS" : tab === "sessions" ? "STATS" : "MCP"}</button>)}
          </div>
          {activePanel === "files" && <div className="inspector-content"><div className="panel-title"><span>EXPLORATEUR LOCAL</span><button onClick={() => void refreshExplorer().catch((reason: unknown) => setError(friendlyError(reason)))}>↻</button></div><div className="current-path" title={filePath}>{filePath.replace(projectPath, "~") || "~"}</div>
            {fileContent ? <div className="file-preview"><button onClick={() => setFileContent("")}>← RETOUR</button><pre>{fileContent}</pre></div> : <div className="file-tree">{filePath !== projectPath && <button className="parent-folder" onClick={() => { const parent = filePath.split("/").slice(0, -1).join("/") || projectPath; void invoke<FileItem[]>("list_project_files", { projectPath, requestedPath: parent }).then((items) => { setFiles(items); setFilePath(parent); setError(""); }).catch((reason: unknown) => setError(friendlyError(reason))); }}>‹ DOSSIER PARENT</button>}{files.map((file) => <button key={file.path} className="file-row" onClick={() => void loadFile(file)}><span>{file.type === "directory" ? "▸" : "·"}</span>{file.name}</button>)}</div>}
            <button className="utility-button" onClick={() => setShowCommand(true)}>$_ TERMINAL (CONFIRMATION REQUISE)</button>
          </div>}
          {activePanel === "sessions" && <div className="inspector-content"><div className="panel-title"><span>STATISTIQUES LOCALES</span></div><p className="empty-side">Cette version autonome ne facture et ne transmet aucun compteur de tokens à un serveur LUCY.</p><p className="current-path">{appState.sessions.length} sessions sauvegardées en local</p><p className="current-path">{currentSession?.messages.length ?? 0} messages dans cette session</p></div>}
          {activePanel === "mcp" && <div className="inspector-content"><div className="panel-title"><span>PROTOCOLE MCP</span></div><p className="empty-side">Les connexions MCP sont disponibles uniquement si le serveur MCP est exposé en API compatible avec le fournisseur. Configuration MCP directe : prévue pour une prochaine version.</p></div>}
        </aside>}
      </section>

      <footer className="statusbar"><div><span className={`status-dot ${ready ? "online" : ""}`} />{ready ? "MOTEUR AUTONOME ACTIF" : "INITIALISATION…"}</div><div className="status-right"><span>{appState.providers.length} FOURNISSEUR{appState.providers.length === 1 ? "" : "S"}</span><span>IDENTIFIANTS LOCAUX</span><span>v0.2.0</span></div></footer>

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
          <div className="modal-kicker">CONNEXIONS // CONFIGURATION LOCALE</div><button className="modal-close" onClick={() => setShowProvider(false)}>×</button><h2>Choisir ton modèle.</h2>
          <p>Importe tes clés API OpenCode ou connecte une API compatible OpenAI — notamment Ollama, sans connexion cloud.</p>
          <button className="primary-button modal-submit" disabled={busy} onClick={() => void importProviders()}>{busy ? "IMPORT EN COURS…" : "↻ IMPORTER AUTOMATIQUEMENT LES COMPTES EXISTANTS"}</button>
          {appState.providers.map((provider) => <div className="provider-card" key={provider.id}><div><strong>{provider.name}</strong><small>{provider.baseUrl} · {provider.models.length} modèle(s) · {provider.source === "oauth" ? "OAuth importé" : provider.source === "import" ? "importé depuis OpenCode" : "configuré localement"}</small>{provider.modelsError && <small className="provider-error">{provider.modelsError}</small>}</div><div className="provider-actions"><button onClick={() => { setProviderId(provider.id); void refreshModels(provider.id); }}>MODÈLES ↻</button><button className="remove-provider" onClick={() => void deleteProvider(provider.id)}>×</button></div></div>)}
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
          <div className="modal-kicker">CLAUDE CODE // SKILLS DU PROJET</div><button className="modal-close" onClick={() => setShowSkills(false)}>×</button><h2>Skills du projet.</h2>
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
          <div className="modal-kicker">SHELL // EXÉCUTION LOCALE</div><button type="button" className="modal-close" onClick={() => setShowCommand(false)}>×</button><h2>Commande système.</h2>
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
    </main>
  );
}

export default App;
