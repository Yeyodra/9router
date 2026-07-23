"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Badge, Button } from "@/shared/components";
import { getModelsByProviderId } from "@/shared/constants/models";
import { isAnthropicCompatibleProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const INSPECTOR_EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 12,
  lineNumbers: "on",
  scrollBeyondLastLine: false,
  wordWrap: "on",
  automaticLayout: true,
  // ponytail: no custom theme tokens; vs-dark matches playground chrome
};

const STORAGE_KEYS = {
  sessions: "playground.sessions",
  activeSessionId: "playground.activeSessionId",
  activeProviderId: "playground.activeProviderId",
  draft: "playground.draft",
};

const LEGACY_STORAGE_KEYS = {
  sessions: "basic-chat.sessions",
  activeSessionId: "basic-chat.activeSessionId",
  activeProviderId: "basic-chat.activeProviderId",
  draft: "basic-chat.draft",
};

let playgroundStorageMigrated = false;

function isEmptyStorageValue(value) {
  return value == null || value === "";
}

/** One-time: copy basic-chat.* → playground.* when new keys missing/empty. */
function ensurePlaygroundStorageMigrated() {
  if (playgroundStorageMigrated || typeof window === "undefined") return;
  playgroundStorageMigrated = true;
  try {
    for (const key of Object.keys(STORAGE_KEYS)) {
      const nextKey = STORAGE_KEYS[key];
      const legacyKey = LEGACY_STORAGE_KEYS[key];
      const current = globalThis.localStorage.getItem(nextKey);
      if (!isEmptyStorageValue(current)) continue;
      const legacy = globalThis.localStorage.getItem(legacyKey);
      if (isEmptyStorageValue(legacy)) continue;
      globalThis.localStorage.setItem(nextKey, legacy);
      globalThis.localStorage.removeItem(legacyKey);
    }
  } catch {
    // Ignore storage errors.
  }
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function humanize(value = "") {
  return String(value)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || "Unknown";
}

function formatRelativeTime(value) {
  if (!value) return "Now";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Now";
  const diffMinutes = Math.max(1, Math.round((Date.now() - time) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.round(diffHours / 24)}d`;
}

function makeSessionTitle(text = "") {
  const normalized = textValue(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 52 ? `${normalized.slice(0, 52).trimEnd()}…` : normalized;
}

function buildUserContent(message) {
  const text = textValue(message.content).trim();
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (attachments.length === 0) return text;

  const content = [];
  if (text) content.push({ type: "text", text });

  for (const attachment of attachments) {
    if (attachment?.dataUrl) {
      content.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    }
  }

  return content.length > 0 ? content : text;
}

function readAssistantText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.content, choice?.message?.content, chunk.output_text, chunk.text]
    .map(textValue)
    .filter(Boolean);
  return pieces[0] || "";
}

function mergeUsage(prev, next) {
  if (!next || typeof next !== "object") return prev;
  return {
    prompt_tokens: next.prompt_tokens ?? prev?.prompt_tokens,
    completion_tokens: next.completion_tokens ?? prev?.completion_tokens,
    total_tokens: next.total_tokens ?? prev?.total_tokens,
  };
}

function routingFromHeaders(headers) {
  if (!headers) return null;
  const provider = headers.get("x-9r-provider");
  const model = headers.get("x-9r-model");
  const connectionId = headers.get("x-9r-connection-id");
  if (!provider && !model && !connectionId) return null;
  return {
    provider: provider || undefined,
    model: model || undefined,
    connectionId: connectionId || undefined,
  };
}

function formatMessageMeta(message) {
  const parts = [];
  const routing = message?.routing;
  if (routing?.provider || routing?.model) {
    parts.push([routing.provider, routing.model].filter(Boolean).join("/"));
  }
  const usage = message?.usage;
  if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    parts.push(`${prompt}+${completion} tokens`);
  } else if (usage?.total_tokens != null) {
    parts.push(`${usage.total_tokens} tokens`);
  }
  return parts.filter(Boolean).join(" · ");
}

function normalizeSession(session) {
  return {
    ...session,
    systemPrompt: typeof session?.systemPrompt === "string" ? session.systemPrompt : "",
    messages: Array.isArray(session?.messages) ? session.messages.map((message) => ({ ...message })) : [],
  };
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function cloneSession(session) {
  return normalizeSession(session);
}

function getProviderLabel(connection) {
  return connection?.name || humanize(connection?.provider || connection?.id || "provider");
}

function normalizeStaticModel(model, connection) {
  if (!model?.id) return null;
  return {
    id: `${connection.provider}/${model.id}`,
    requestModel: `${connection.provider}/${model.id}`,
    name: model.name || model.id,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "static",
  };
}

function normalizeLiveModel(model, connection) {
  const rawId = typeof model === "string" ? model : model?.id || model?.name || model?.model || "";
  if (!rawId) return null;

  const displayName = typeof model === "string"
    ? model
    : model?.name || model?.displayName || rawId;

  let requestModel = rawId;
  const isCompatible = isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider);
  if (isCompatible && !rawId.includes("/")) {
    requestModel = `${connection.provider}/${rawId}`;
  }

  return {
    id: requestModel,
    requestModel,
    name: displayName,
    providerId: connection.provider,
    providerName: getProviderLabel(connection),
    source: "live",
  };
}

// requestModel must be bare combo name — getComboModels rejects provider-style ids with `/`
function normalizeComboModel(combo) {
  const name = typeof combo?.name === "string" ? combo.name.trim() : "";
  if (!name) return null;
  return {
    id: `combo:${name}`,
    requestModel: name,
    name,
    providerId: "combo",
    providerName: "Combo",
    source: "combo",
    isCombo: true,
  };
}

function parseProviderModelsPayload(data) {
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

function dedupeModels(models) {
  const map = new Map();
  for (const model of models) {
    if (!model?.id) continue;
    if (!map.has(model.id)) map.set(model.id, model);
  }
  return Array.from(map.values());
}

export default function PlaygroundPageClient() {
  const { copied, copy } = useCopyToClipboard();
  const [providerGroups, setProviderGroups] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sessions, setSessions] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      ensurePlaygroundStorageMigrated();
      const saved = safeParse(globalThis.localStorage.getItem(STORAGE_KEYS.sessions), []);
      return Array.isArray(saved) ? saved.map(normalizeSession) : [];
    } catch { return []; }
  });
  const [activeSessionId, setActiveSessionId] = useState(() => {
    if (typeof window === "undefined") return "";
    ensurePlaygroundStorageMigrated();
    return globalThis.localStorage.getItem(STORAGE_KEYS.activeSessionId) || "";
  });
  const [activeProviderId, setActiveProviderId] = useState(() => {
    if (typeof window === "undefined") return "";
    ensurePlaygroundStorageMigrated();
    return globalThis.localStorage.getItem(STORAGE_KEYS.activeProviderId) || "";
  });
  const [activeModelId, setActiveModelId] = useState("");
  const [draft, setDraft] = useState(() => {
    if (typeof window === "undefined") return "";
    ensurePlaygroundStorageMigrated();
    return globalThis.localStorage.getItem(STORAGE_KEYS.draft) || "";
  });
  const [attachments, setAttachments] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [rawRequest, setRawRequest] = useState("");
  const [rawResponse, setRawResponse] = useState("");
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const initializedRef = useRef(false);
  const modelMenuRef = useRef(null);
  const historyMenuRef = useRef(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only hydration gate
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoadingData(true);
      setLoadError("");

      try {
        const [providersRes, combosRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store", credentials: "same-origin" }),
          fetch("/api/combos", { cache: "no-store", credentials: "same-origin" }),
        ]);
        const providersData = await providersRes.json().catch(() => ({}));
        const combosData = combosRes.ok ? await combosRes.json().catch(() => ({})) : {};
        const connections = Array.isArray(providersData.connections)
          ? providersData.connections.filter((connection) => connection?.isActive !== false)
          : [];
        const comboModels = (Array.isArray(combosData.combos) ? combosData.combos : [])
          .map(normalizeComboModel)
          .filter(Boolean)
          .sort((a, b) => a.name.localeCompare(b.name));
        const comboGroup = comboModels.length > 0
          ? {
            providerId: "combo",
            providerName: "Combos",
            providerType: "combo",
            connections: [],
            models: comboModels,
          }
          : null;

        if (connections.length === 0) {
          if (!cancelled) {
            setProviderGroups(comboGroup ? [comboGroup] : []);
            setLoadError(comboGroup ? "" : "No providers connected yet. Connect one on the Providers page.");
          }
          return;
        }

        // Model lists are provider-level; keep all connections but fetch once per provider.
        const providerMap = new Map();
        const uniqueByProvider = new Map();

        for (const connection of connections) {
          const providerId = connection.provider || connection.id;
          const providerName = getProviderLabel(connection);
          const providerType = isOpenAICompatibleProvider(providerId)
            ? "openai-compatible"
            : isAnthropicCompatibleProvider(providerId)
              ? "anthropic-compatible"
              : providerId;

          if (!providerMap.has(providerId)) {
            const staticModels = getModelsByProviderId(providerId)
              .map((model) => normalizeStaticModel(model, connection))
              .filter(Boolean);
            providerMap.set(providerId, {
              providerId,
              providerName,
              providerType,
              connections: [],
              models: staticModels,
            });
            uniqueByProvider.set(providerId, connection);
          }

          const group = providerMap.get(providerId);
          group.providerName = group.providerName || providerName;
          group.providerType = group.providerType || providerType;
          group.connections.push(connection);
        }

        const buildNormalized = () => {
          const groups = Array.from(providerMap.values())
            .map((group) => ({
              ...group,
              models: dedupeModels(group.models).sort((a, b) => a.name.localeCompare(b.name)),
            }))
            .filter((group) => group.models.length > 0)
            .sort((a, b) => a.providerName.localeCompare(b.providerName));
          if (comboGroup) groups.unshift(comboGroup);
          return groups;
        };

        // Surface static catalog immediately so the menu is not empty during live fetches.
        if (!cancelled) {
          setProviderGroups(buildNormalized());
        }

        const uniqueConnections = Array.from(uniqueByProvider.values());
        const liveResults = await Promise.all(
          uniqueConnections.map(async (connection) => {
            try {
              const response = await fetch(`/api/providers/${connection.id}/models`, {
                cache: "no-store",
                credentials: "same-origin",
              });
              const data = await response.json().catch(() => ({}));
              if (!response.ok) return { connection, models: [] };
              const models = parseProviderModelsPayload(data)
                .map((model) => normalizeLiveModel(model, connection))
                .filter(Boolean);
              return { connection, models };
            } catch {
              return { connection, models: [] };
            }
          })
        );

        for (const result of liveResults) {
          const providerId = result.connection.provider || result.connection.id;
          const group = providerMap.get(providerId);
          if (!group) continue;
          group.models.push(...result.models);
        }

        const normalized = buildNormalized();

        if (!cancelled) {
          setProviderGroups(normalized);
          if (normalized.length === 0) {
            setLoadError(
              comboGroup
                ? "No provider models available. Combos are listed; add models on Providers if needed."
                : "Providers connected but no models available. Check Providers or create a Combo.",
            );
          }
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(textValue(error?.message) || "Failed to load providers/models. Retry or check Providers.");
          setProviderGroups([]);
        }
      } finally {
        if (!cancelled) setLoadingData(false);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target)) {
        setModelMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(event.target)) {
        setHistoryOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const modelIndex = useMemo(() => {
    const map = new Map();
    for (const group of providerGroups) {
      for (const model of group.models) {
        map.set(model.id, {
          ...model,
          providerId: model.providerId || group.providerId,
          // Keep model-level label ("Combo") when set; group uses "Combos" for the section header
          providerName: model.providerName || group.providerName,
        });
      }
    }
    return map;
  }, [providerGroups]);

  const activeProviderGroup = useMemo(() => {
    return providerGroups.find((group) => group.providerId === activeProviderId) || providerGroups[0] || null;
  }, [providerGroups, activeProviderId]);

  const activeModel = useMemo(() => {
    if (activeModelId && modelIndex.has(activeModelId)) return modelIndex.get(activeModelId);
    if (activeSessionId) {
      const session = sessions.find((item) => item.id === activeSessionId);
      if (session?.modelId && modelIndex.has(session.modelId)) return modelIndex.get(session.modelId);
    }
    return activeProviderGroup?.models?.[0] || null;
  }, [activeModelId, modelIndex, activeProviderGroup, sessions, activeSessionId]);

  const currentSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) || null, [sessions, activeSessionId]);
  const currentMessages = currentSession?.messages || [];
  const sessionItems = useMemo(() => [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [sessions]);
  const canSend = !isSending && !!activeModel && (draft.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      globalThis.localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
      globalThis.localStorage.setItem(STORAGE_KEYS.activeSessionId, activeSessionId);
      globalThis.localStorage.setItem(STORAGE_KEYS.activeProviderId, activeProviderId);
      globalThis.localStorage.setItem(STORAGE_KEYS.draft, draft);
    } catch {
      // Ignore storage errors.
    }
  }, [isHydrated, sessions, activeSessionId, activeProviderId, draft]);

  /* eslint-disable react-hooks/set-state-in-effect -- bootstrap session after providers load */
  useEffect(() => {
    if (!isHydrated || loadingData || initializedRef.current) return;
    if (providerGroups.length === 0) return;

    const savedProvider = providerGroups.find((group) => group.providerId === activeProviderId) || providerGroups[0];
    const savedModel = activeModelId && modelIndex.has(activeModelId)
      ? modelIndex.get(activeModelId)
      : savedProvider.models[0];

    if (sessions.length > 0) {
      const session = sessions.find((item) => item.id === activeSessionId) || sessions[0];
      const sessionModel = session?.modelId && modelIndex.has(session.modelId)
        ? modelIndex.get(session.modelId)
        : savedModel;
      initializedRef.current = true;
      setActiveSessionId(session.id);
      setActiveProviderId(sessionModel?.providerId || savedProvider.providerId);
      setActiveModelId(sessionModel?.id || savedModel.id);
      return;
    }

    const session = {
      id: createId(),
      title: "New chat",
      providerId: savedProvider.providerId,
      providerName: savedProvider.providerName,
      modelId: savedModel.id,
      modelName: savedModel.name,
      systemPrompt: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    initializedRef.current = true;
    setSessions([session]);
    setActiveSessionId(session.id);
    setActiveProviderId(savedProvider.providerId);
    setActiveModelId(savedModel.id);
  }, [isHydrated, loadingData, providerGroups, modelIndex, sessions, activeSessionId, activeProviderId, activeModelId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const updateSession = (sessionId, updater) => {
    setSessions((prev) => prev.map((session) => (session.id === sessionId ? updater(cloneSession(session)) : session)));
  };

  const ensureSessionForModel = (model) => {
    if (!model) return null;
    return {
      id: createId(),
      title: "New chat",
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.id,
      modelName: model.name,
      systemPrompt: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
  };

  const setSessionSystemPrompt = (value) => {
    if (!activeSessionId) return;
    updateSession(activeSessionId, (session) => ({
      ...session,
      systemPrompt: value,
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleNewChat = () => {
    if (!activeModel) return;
    const session = ensureSessionForModel(activeModel);
    if (!session) return;
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setActiveProviderId(session.providerId);
    setActiveModelId(session.modelId);
    setDraft("");
    setAttachments([]);
    setStreamingMessageId("");
    setStreamingText("");
  };

  const handleSelectSession = (sessionId) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    setActiveSessionId(sessionId);
    setActiveProviderId(session.providerId || activeProviderId);
    setActiveModelId(session.modelId || activeModelId);
    setHistoryOpen(false);
  };

  const handleDeleteCurrentChat = () => {
    if (!activeSessionId) return;
    const nextSessions = sessions.filter((session) => session.id !== activeSessionId);
    const fallback = nextSessions[0] || null;
    setSessions(nextSessions);
    if (fallback) {
      setActiveSessionId(fallback.id);
      setActiveProviderId(fallback.providerId);
      setActiveModelId(fallback.modelId);
    } else {
      setActiveSessionId("");
      setActiveProviderId("");
      setActiveModelId("");
    }
  };

  const handleSelectProvider = (providerId) => {
    const group = providerGroups.find((item) => item.providerId === providerId);
    if (!group || group.models.length === 0) return;
    const nextModel = group.models[0];

    const current = sessions.find((session) => session.id === activeSessionId);
    if (current && current.messages.length > 0) {
      const session = ensureSessionForModel(nextModel);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    } else if (current) {
      setSessions((prev) => prev.map((item) => (item.id === current.id ? {
        ...item,
        providerId: group.providerId,
        providerName: group.providerName,
        modelId: nextModel.id,
        modelName: nextModel.name,
      } : item)));
      setActiveSessionId(current.id);
    }

    setActiveProviderId(group.providerId);
    setActiveModelId(nextModel.id);
    setModelMenuOpen(false);
  };

  const handleSelectModel = (modelId) => {
    const model = modelIndex.get(modelId);
    if (!model) return;

    const current = sessions.find((session) => session.id === activeSessionId);
    if (current && current.messages.length > 0) {
      const session = ensureSessionForModel(model);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    } else if (current) {
      setSessions((prev) => prev.map((item) => (item.id === current.id ? {
        ...item,
        providerId: model.providerId,
        providerName: model.providerName,
        modelId: model.id,
        modelName: model.name,
      } : item)));
      setActiveSessionId(current.id);
    } else {
      const session = ensureSessionForModel(model);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    }

    setActiveProviderId(model.providerId);
    setActiveModelId(model.id);
    setModelMenuOpen(false);
  };

  const handleAttachFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      event.target.value = "";
      return;
    }

    const converted = await Promise.all(images.map(async (file) => ({
      id: createId(),
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: await fileToDataUrl(file),
    })));

    setAttachments((prev) => [...prev, ...converted]);
    event.target.value = "";
  };

  const removeAttachment = (attachmentId) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const finalizeSessionTitle = (sessionId, titleSeed) => {
    const title = makeSessionTitle(titleSeed);
    updateSession(sessionId, (session) => ({
      ...session,
      title: session.title === "New chat" ? title : session.title,
      updatedAt: new Date().toISOString(),
    }));
  };

  const sendMessage = async () => {
    const model = activeModel || activeProviderGroup?.models?.[0] || null;
    if (!model) return;

    const userText = draft.trim();
    if (!userText && attachments.length === 0) return;

    let sessionId = activeSessionId;
    let session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      session = ensureSessionForModel(model);
      if (!session) return;
      sessionId = session.id;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(sessionId);
    }

    const userMessage = {
      id: createId(),
      role: "user",
      content: userText,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
        dataUrl: attachment.dataUrl,
      })),
      createdAt: new Date().toISOString(),
    };

    const assistantMessageId = createId();
    const assistantMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "streaming",
    };

    const nextMessages = [...(session.messages || []), userMessage, assistantMessage];
    setSessions((prev) => prev.map((item) => (item.id === sessionId ? {
      ...item,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.id,
      modelName: model.name,
      messages: nextMessages,
      updatedAt: new Date().toISOString(),
      title: item.title === "New chat" ? makeSessionTitle(userText) : item.title,
    } : item)));
    setDraft("");
    setAttachments([]);
    setIsSending(true);
    setStreamingMessageId(assistantMessageId);
    setStreamingText("");
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const conversation = nextMessages
      .filter((message) => !(message.role === "assistant" && message.id === assistantMessageId))
      .map((message) => ({
        role: message.role,
        content: message.role === "user" ? buildUserContent(message) : message.content,
      }));
    const systemPrompt = textValue(session.systemPrompt).trim();
    const requestMessages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...conversation,
    ];
    const requestBody = {
      model: model.requestModel || model.id,
      messages: requestMessages,
      stream: true,
    };

    // Inspector: body only — never cookies / Authorization / API keys
    setRawRequest(JSON.stringify(requestBody, null, 2));
    setRawResponse("");

    try {
      const response = await fetch("/api/dashboard/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        credentials: "same-origin",
        body: JSON.stringify(requestBody),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        try {
          setRawResponse(JSON.stringify(errorData, null, 2) || `HTTP ${response.status}`);
        } catch {
          setRawResponse(`HTTP ${response.status}`);
        }
        throw new Error(textValue(errorData.error || errorData.message || `Request failed (${response.status})`));
      }

      let usage = null;
      let routing = routingFromHeaders(response.headers);

      const patchAssistant = (patch) => {
        updateSession(sessionId, (currentSession) => ({
          ...currentSession,
          messages: currentSession.messages.map((message) => (
            message.id === assistantMessageId ? { ...message, ...patch } : message
          )),
          updatedAt: new Date().toISOString(),
        }));
      };

      const reader = response.body?.getReader();
      if (!reader) {
        const data = await response.json().catch(() => ({}));
        try {
          setRawResponse(JSON.stringify(data, null, 2));
        } catch {
          setRawResponse(String(data));
        }
        const fallbackText = textValue(data?.choices?.[0]?.message?.content || data?.output_text || data?.error || data?.message || "");
        usage = mergeUsage(usage, data?.usage);
        if (data?.object === "9router.meta") {
          routing = {
            provider: data.provider || routing?.provider,
            model: data.model || routing?.model,
            connectionId: data.connectionId || routing?.connectionId,
          };
          usage = mergeUsage(usage, data.usage);
        }
        patchAssistant({
          content: fallbackText,
          status: "done",
          ...(usage ? { usage } : {}),
          ...(routing ? { routing } : {}),
        });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const wireChunk = decoder.decode(value, { stream: true });
        buffer += wireChunk;
        setRawResponse((prev) => prev + wireChunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload);

            if (chunk?.object === "9router.meta") {
              routing = {
                provider: chunk.provider || routing?.provider,
                model: chunk.model || routing?.model,
                connectionId: chunk.connectionId || routing?.connectionId,
              };
              usage = mergeUsage(usage, chunk.usage);
              patchAssistant({
                content: assistantText,
                status: "streaming",
                ...(usage ? { usage } : {}),
                ...(routing ? { routing } : {}),
              });
              continue;
            }

            usage = mergeUsage(usage, chunk.usage);
            const text = readAssistantText(chunk);
            if (!text) {
              if (usage || routing) {
                patchAssistant({
                  content: assistantText,
                  status: "streaming",
                  ...(usage ? { usage } : {}),
                  ...(routing ? { routing } : {}),
                });
              }
              continue;
            }

            assistantText += text;
            setStreamingText(assistantText);
            patchAssistant({
              content: assistantText,
              status: "streaming",
              ...(usage ? { usage } : {}),
              ...(routing ? { routing } : {}),
            });
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      // Flush any trailing decoder bytes into inspector
      const tail = decoder.decode();
      if (tail) setRawResponse((prev) => prev + tail);

      updateSession(sessionId, (currentSession) => ({
        ...currentSession,
        messages: currentSession.messages.map((message) => (
          message.id === assistantMessageId
            ? {
              ...message,
              content: assistantText || message.content,
              status: "done",
              ...(usage ? { usage } : {}),
              ...(routing ? { routing } : {}),
            }
            : message
        )),
        updatedAt: new Date().toISOString(),
      }));
      finalizeSessionTitle(sessionId, userText);
    } catch (error) {
      if (error.name !== "AbortError") {
        const errorText = textValue(error?.message || error);
        setRawResponse((prev) => (prev ? `${prev}\n\n// error: ${errorText}` : `// error: ${errorText}`));
        updateSession(sessionId, (currentSession) => ({
          ...currentSession,
          messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: message.content || `Error: ${errorText}`, status: "error" } : message)),
          updatedAt: new Date().toISOString(),
        }));
        setLoadError(errorText || "Failed to send message.");
      }
    } finally {
      setIsSending(false);
      setStreamingMessageId("");
      setStreamingText("");
      abortRef.current = null;
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) sendMessage();
    }
  };

  const modelLabel = activeModel ? `${activeModel.name}` : "Select model";
  const modelSubLabel = activeModel ? activeModel.requestModel : "Choose from connected providers";

  return (
    <div className="relative flex flex-1 flex-col h-full min-h-0 min-w-0 bg-[#212121] text-white overflow-hidden">
      {/* flex-1 min-h-0 (no h-full) so bottom inspector can claim space without clipping */}
      <div className="relative mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setModelMenuOpen((value) => !value)}
              className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:bg-white/8"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{modelLabel}</span>
                  <span className="material-symbols-outlined text-[18px] text-white/70">expand_more</span>
                </div>
                <p className="truncate text-xs text-white/55">{modelSubLabel}</p>
              </div>
            </button>

            {modelMenuOpen ? (
              <div className="absolute left-0 top-[calc(100%+10px)] z-30 w-[min(520px,calc(100vw-2rem))] overflow-hidden rounded-[20px] border border-white/10 bg-[#262626] shadow-2xl shadow-black/50">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Models</p>
                  <p className="text-sm text-white/75">Connected providers and combos</p>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-2 custom-scrollbar">
                  {providerGroups.map((group) => (
                    <div key={group.providerId} className="mb-2 rounded-[16px] border border-white/10 bg-black/20 p-2">
                      <div className="flex items-center justify-between px-2 py-2">
                        <p className="text-sm font-semibold text-white">{group.providerName}</p>
                        <Badge size="sm" variant="default">{group.models.length}</Badge>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {group.models.map((model) => {
                          const isActive = model.id === activeModelId;
                          return (
                            <button
                              key={model.id}
                              type="button"
                              onClick={() => handleSelectModel(model.id)}
                              className={`rounded-[14px] border px-3 py-3 text-left transition ${isActive ? "border-blue-400/40 bg-blue-500/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-white">{model.name}</p>
                                  <p className="truncate text-[11px] text-white/45">{model.requestModel}</p>
                                </div>
                                {isActive ? <span className="material-symbols-outlined text-[18px] text-blue-300">check_circle</span> : null}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setInspectorOpen((value) => !value)}
              className={`rounded-2xl border px-4 py-3 text-sm transition ${inspectorOpen ? "border-blue-400/40 bg-blue-500/15 text-white" : "border-white/10 bg-white/5 text-white/80 hover:bg-white/8"}`}
              aria-pressed={inspectorOpen}
              title="Toggle raw request/response inspector"
            >
              Debug
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80 transition hover:bg-white/8"
            >
              History
            </button>
            <Button variant="ghost" size="sm" icon="delete" onClick={handleDeleteCurrentChat} disabled={!activeSessionId || sessions.length === 0}>
              Clear
            </Button>
          </div>
        </div>

        {historyOpen ? (
          <div ref={historyMenuRef} className="absolute right-4 top-[72px] z-20 w-[min(360px,calc(100vw-2rem))] rounded-[20px] border border-white/10 bg-[#262626] p-2 shadow-2xl shadow-black/50 lg:right-6">
            <div className="px-3 py-2">
              <p className="text-xs uppercase tracking-[0.22em] text-white/45">Recent chats</p>
            </div>
            <div className="max-h-[48vh] space-y-2 overflow-y-auto p-1 custom-scrollbar">
              {sessionItems.length === 0 ? (
                <div className="rounded-[16px] border border-dashed border-white/10 bg-white/5 p-4 text-sm text-white/55">
                  No conversations yet.
                </div>
              ) : sessionItems.map((session) => {
                const isActive = session.id === activeSessionId;
                const latestMessage = [...(session.messages || [])].reverse().find((message) => message.role === "user") || session.messages?.[0];
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleSelectSession(session.id)}
                    className={`w-full rounded-[16px] border px-3 py-3 text-left transition ${isActive ? "border-blue-400/40 bg-blue-500/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{session.title}</p>
                        <p className="mt-1 truncate text-xs text-white/50">{textValue(latestMessage?.content) || "Empty chat"}</p>
                      </div>
                      <span className="text-[10px] text-white/40 shrink-0">{formatRelativeTime(session.updatedAt)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {loadError ? (
          <div className="mt-4 mx-4 lg:mx-6 rounded-[18px] border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-rose-100">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-[20px] shrink-0">error</span>
              <div className="min-w-0 space-y-2">
                <p className="text-sm leading-6 break-words">{loadError}</p>
                <div className="flex flex-wrap gap-2">
                  {/provider|model|load/i.test(loadError) ? (
                    <Link href="/dashboard/providers" className="rounded-full border border-rose-300/30 bg-rose-500/15 px-3 py-1 text-xs font-medium text-rose-50 hover:bg-rose-500/25">
                      Providers
                    </Link>
                  ) : null}
                  {/combo/i.test(loadError) ? (
                    <Link href="/dashboard/combos" className="rounded-full border border-rose-300/30 bg-rose-500/15 px-3 py-1 text-xs font-medium text-rose-50 hover:bg-rose-500/25">
                      Combos
                    </Link>
                  ) : null}
                  {/api key|endpoint|no active/i.test(loadError) ? (
                    <Link href="/dashboard/endpoint" className="rounded-full border border-rose-300/30 bg-rose-500/15 px-3 py-1 text-xs font-medium text-rose-50 hover:bg-rose-500/25">
                      Endpoint & Key
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 overflow-y-auto py-4 custom-scrollbar">
            {currentMessages.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center px-4 text-center">
                <div className="max-w-xl space-y-4">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-[20px] border border-white/10 bg-white/5 text-white/80">
                    <span className="material-symbols-outlined text-[30px]">
                      {!loadingData && providerGroups.length === 0 ? "cloud_off" : "chat"}
                    </span>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold text-white">
                      {!loadingData && providerGroups.length === 0
                        ? "Nothing to chat with yet"
                        : "Start a conversation"}
                    </h2>
                    <p className="text-sm leading-6 text-white/60">
                      {!loadingData && providerGroups.length === 0
                        ? "Connect a provider, create a combo, or add an API key — then pick a model here."
                        : "Select a model (or combo) and start chatting. Use the inspector for raw request/response."}
                    </p>
                  </div>
                  {!loadingData && providerGroups.length === 0 ? (
                    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                      <Link href="/dashboard/providers" className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-medium text-white hover:bg-white/15">
                        Providers
                      </Link>
                      <Link href="/dashboard/combos" className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-medium text-white hover:bg-white/15">
                        Combos
                      </Link>
                      <Link href="/dashboard/endpoint" className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-medium text-white hover:bg-white/15">
                        Endpoint & Key
                      </Link>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4">
              {currentMessages.map((message) => {
                const isUser = message.role === "user";
                const isAssistant = message.role === "assistant";
                const isStreaming = isAssistant && message.id === streamingMessageId && message.status === "streaming";
                const content = textValue(message.content) || (isAssistant ? streamingText : "");
                const metaLine = isAssistant ? formatMessageMeta(message) : "";

                return (
                  <div key={message.id} className={`flex w-full ${isUser ? "justify-end" : "justify-start"} mb-6`}>
                    <div className={`max-w-[min(88%,42rem)] ${isUser ? "rounded-3xl bg-[#2f2f2f] px-5 py-3.5 text-white" : "text-white/90"}`}>
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold">{isUser ? "You" : activeModel?.name || "Assistant"}</span>
                      </div>

                      {message.attachments?.length ? (
                        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 mt-2">
                          {message.attachments.map((attachment) => (
                            <a key={attachment.id} href={attachment.dataUrl} target="_blank" rel="noreferrer" className="overflow-hidden rounded-[18px] border border-white/10 bg-black/20">
                              <img src={attachment.dataUrl} alt={attachment.name} className="h-28 w-full object-cover" />
                            </a>
                          ))}
                        </div>
                      ) : null}

                      <div className="whitespace-pre-wrap break-words text-[15px] leading-7">
                        {content}
                        {isAssistant && isStreaming && !streamingText ? <span className="inline-block animate-pulse">▋</span> : null}
                      </div>
                      {metaLine ? (
                        <p className="mt-2 text-[11px] leading-4 text-white/40">{metaLine}</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="shrink-0 pt-2">
            {attachments.length > 0 ? (
              <div className="mx-auto mb-3 flex w-full max-w-3xl flex-wrap gap-2 px-4">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2">
                    <span className="text-xs text-white/80 max-w-[12rem] truncate">{attachment.name}</span>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} className="text-white/55 hover:text-white" aria-label="Remove attachment">
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              <div className="mb-2 rounded-[18px] border border-white/10 bg-white/5">
                <button
                  type="button"
                  onClick={() => setSystemPromptOpen((open) => !open)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                >
                  <span className="text-xs font-medium text-white/60">
                    System prompt{currentSession?.systemPrompt?.trim() ? " · set" : ""}
                  </span>
                  <span className="material-symbols-outlined text-[18px] text-white/45">
                    {systemPromptOpen ? "expand_less" : "expand_more"}
                  </span>
                </button>
                {systemPromptOpen ? (
                  <div className="border-t border-white/10 px-3 pb-3 pt-2">
                    <textarea
                      value={currentSession?.systemPrompt || ""}
                      onChange={(event) => setSessionSystemPrompt(event.target.value)}
                      placeholder="Optional system instructions for this session"
                      rows={3}
                      disabled={!currentSession}
                      className="w-full resize-y rounded-[12px] border border-white/10 bg-black/20 px-3 py-2 text-[13px] leading-5 text-white outline-none placeholder:text-white/35 custom-scrollbar max-h-[20vh]"
                    />
                  </div>
                ) : null}
              </div>

              <div className="rounded-[26px] bg-[#2f2f2f] px-3 pt-3 pb-2 shadow-[0_0_15px_rgba(0,0,0,0.10)] ring-1 ring-white/5">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Message AI"
                  rows={1}
                  className="w-full resize-none bg-transparent px-2 text-[15px] leading-6 text-white outline-none placeholder:text-white/40 custom-scrollbar max-h-[25vh] overflow-y-auto"
                />

                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!activeModel || loadingData} className="p-2 text-white/50 hover:text-white transition rounded-full hover:bg-white/5">
                      <span className="material-symbols-outlined text-[20px]">attach_file</span>
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleAttachFiles} />
                    <span className="text-xs font-medium text-white/30 truncate max-w-[120px]">{activeModel ? activeModel.name : "No model"}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {isSending ? (
                      <button type="button" onClick={handleStop} className="p-2 text-white bg-white/10 hover:bg-white/20 transition rounded-full h-8 w-8 flex items-center justify-center">
                        <span className="material-symbols-outlined text-[16px]">stop</span>
                      </button>
                    ) : null}
                    <button onClick={sendMessage} disabled={!canSend} className={`h-8 w-8 rounded-full flex items-center justify-center transition ${canSend ? 'bg-white text-black hover:opacity-90' : 'bg-white/10 text-white/30 cursor-not-allowed'}`}>
                      <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="mx-auto mt-2 max-w-3xl px-4 pb-4 text-center text-[11px] text-white/30">
            Model list is filtered from connected providers.
          </p>
        </div>
      </div>

      <div className="shrink-0 border-t border-white/10 bg-[#1a1a1a]">
        <div className={`flex items-center justify-between gap-3 px-4 py-2${inspectorOpen ? " border-b border-white/10" : ""}`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-[18px] text-white/55">terminal</span>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/55">Inspector</p>
            <span className="truncate text-[11px] text-white/35">last request / raw SSE · no secrets</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {inspectorOpen ? (
              <>
                <button
                  type="button"
                  onClick={() => { if (rawRequest) copy(rawRequest, "req"); }}
                  disabled={!rawRequest}
                  className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/10 disabled:opacity-40"
                >
                  {copied === "req" ? "Copied" : "Copy req"}
                </button>
                <button
                  type="button"
                  onClick={() => { if (rawResponse) copy(rawResponse, "res"); }}
                  disabled={!rawResponse}
                  className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/10 disabled:opacity-40"
                >
                  {copied === "res" ? "Copied" : "Copy res"}
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setInspectorOpen((value) => !value)}
              className="rounded-lg border border-white/10 bg-white/5 p-1 text-white/55 transition hover:bg-white/10 hover:text-white"
              aria-label={inspectorOpen ? "Collapse inspector" : "Expand inspector"}
              aria-expanded={inspectorOpen}
            >
              <span className="material-symbols-outlined text-[18px]">{inspectorOpen ? "expand_more" : "expand_less"}</span>
            </button>
          </div>
        </div>
        {inspectorOpen ? (
          <div className="grid grid-cols-1 divide-y divide-white/10 md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="flex min-h-0 flex-col">
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-[11px] font-medium text-white/50">Request</span>
                <Badge size="sm" variant="default">JSON</Badge>
              </div>
              <div className="overflow-hidden border-t border-white/5">
                {rawRequest ? (
                  <Editor
                    height="220px"
                    defaultLanguage="json"
                    language="json"
                    value={rawRequest}
                    theme="vs-dark"
                    options={INSPECTOR_EDITOR_OPTIONS}
                  />
                ) : (
                  <pre className="h-[220px] overflow-auto px-3 py-2 font-mono text-[11px] leading-5 text-white/35 custom-scrollbar">
                    Send a message to capture the outbound body.
                  </pre>
                )}
              </div>
            </div>
            <div className="flex min-h-0 flex-col">
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-[11px] font-medium text-white/50">Response</span>
                <Badge size="sm" variant="default">SSE</Badge>
              </div>
              <div className="overflow-hidden border-t border-white/5">
                {rawResponse ? (
                  <Editor
                    height="220px"
                    defaultLanguage="plaintext"
                    language="plaintext"
                    value={rawResponse}
                    theme="vs-dark"
                    options={INSPECTOR_EDITOR_OPTIONS}
                  />
                ) : (
                  <pre className="h-[220px] overflow-auto px-3 py-2 font-mono text-[11px] leading-5 text-white/35 custom-scrollbar">
                    Wire SSE text appears here as the stream arrives.
                  </pre>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
