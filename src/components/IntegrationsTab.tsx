import React, { useEffect, useState } from 'react';
import { safeFetchJson } from '../lib/uploadClient';
import type {
  FullProjectBundle,
  IntegrationAuditLog,
  IntegrationConnection,
  IntegrationProviderId,
} from '../types/domain';

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const { data } = await safeFetchJson<T>(url, init);
  return data;
}

interface IntegrationsTabProps {
  bundle: FullProjectBundle;
}

export const IntegrationsTab: React.FC<IntegrationsTabProps> = ({ bundle }) => {
  const [integrations, setIntegrations] = useState<IntegrationConnection[]>(
    bundle.integrations || []
  );
  const [auditLogs, setAuditLogs] = useState<IntegrationAuditLog[]>(
    bundle.integrationLogs || []
  );
  const [selectedProvider, setSelectedProvider] =
    useState<IntegrationProviderId>('mcp_server_bridge');
  const [credentialInput, setCredentialInput] = useState('');
  const [accountLabelInput, setAccountLabelInput] = useState('');
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [pendingConfirmTool, setPendingConfirmTool] = useState<{
    providerId: IntegrationProviderId;
    providerName: string;
    toolName: string;
    description: string;
  } | null>(null);
  const [statusFeedback, setStatusFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const loadIntegrations = async () => {
    try {
      const data = await fetchJson<{
        integrations: IntegrationConnection[];
        auditLogs: IntegrationAuditLog[];
      }>('/api/integrations');
      setIntegrations(data.integrations || []);
      setAuditLogs(data.auditLogs || []);
    } catch {
      // keep bundle fallback
    }
  };

  useEffect(() => {
    void loadIntegrations();
  }, [bundle.project.id]);

  const activeIntegration =
    integrations.find((i) => i.providerId === selectedProvider) ||
    integrations[0];

  const handleConnect = async (providerId: IntegrationProviderId) => {
    setBusyProvider(providerId);
    setStatusFeedback(null);
    try {
      const res = await fetchJson<{
        integration: IntegrationConnection;
        integrations: IntegrationConnection[];
        auditLogs: IntegrationAuditLog[];
      }>(`/api/integrations/${providerId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: bundle.project.id,
          endpointOrToken: credentialInput.trim(),
          accountLabel: accountLabelInput.trim() || undefined,
        }),
      });
      setIntegrations(res.integrations);
      setAuditLogs(res.auditLogs);
      setCredentialInput('');
      setAccountLabelInput('');
      setStatusFeedback({
        type: 'success',
        message: `Connected and verified ${res.integration.name}.`,
      });
    } catch (err: any) {
      setStatusFeedback({
        type: 'error',
        message: err.message || 'Connection failed.',
      });
    } finally {
      setBusyProvider(null);
    }
  };

  const handleDisconnect = async (providerId: IntegrationProviderId) => {
    setBusyProvider(providerId);
    setStatusFeedback(null);
    try {
      const res = await fetchJson<{
        integrations: IntegrationConnection[];
        auditLogs: IntegrationAuditLog[];
      }>(`/api/integrations/${providerId}/disconnect`, {
        method: 'POST',
      });
      setIntegrations(res.integrations);
      setAuditLogs(res.auditLogs);
      setStatusFeedback({
        type: 'success',
        message: 'Integration disconnected.',
      });
    } catch (err: any) {
      setStatusFeedback({
        type: 'error',
        message: err.message || 'Disconnect failed.',
      });
    } finally {
      setBusyProvider(null);
    }
  };

  const toggleToolAllowlist = async (
    integration: IntegrationConnection,
    toolName: string
  ) => {
    const nextAllowed = integration.mcpTools
      .filter((t) => (t.name === toolName ? !t.allowed : t.allowed))
      .map((t) => t.name);

    setIntegrations((prev) =>
      prev.map((item) =>
        item.providerId === integration.providerId
          ? {
              ...item,
              mcpTools: item.mcpTools.map((t) =>
                t.name === toolName ? { ...t, allowed: !t.allowed } : t
              ),
            }
          : item
      )
    );

    if (integration.status === 'connected') {
      try {
        await fetchJson(`/api/integrations/${integration.providerId}/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: bundle.project.id,
            endpointOrToken:
              integration.configuredEndpoint || 'verified-session-token',
            accountLabel: integration.accountLabel,
            allowedTools: nextAllowed,
          }),
        });
      } catch {
        // local state updated
      }
    }
  };

  const executeTool = async (params: {
    providerId: IntegrationProviderId;
    toolName: string;
    userConfirmed: boolean;
  }) => {
    setBusyProvider(`${params.providerId}:${params.toolName}`);
    setStatusFeedback(null);
    try {
      const res = await fetchJson<{
        ok: boolean;
        logEntry: IntegrationAuditLog;
        auditLogs: IntegrationAuditLog[];
      }>(`/api/integrations/${params.providerId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: bundle.project.id,
          toolName: params.toolName,
          userConfirmed: params.userConfirmed,
        }),
      });
      setAuditLogs(res.auditLogs);
      setPendingConfirmTool(null);
      setStatusFeedback({
        type: 'success',
        message: res.logEntry.actionSummary || res.logEntry.detail || 'Executed tool successfully.',
      });
    } catch (err: any) {
      setStatusFeedback({
        type: 'error',
        message: err.message || 'Tool execution failed.',
      });
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="text-xs font-mono uppercase tracking-wider text-slate-500">
            Step 9: Model Context Protocol (MCP) & Connected Content Operations
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-0.5">
            External Integrations & MCP Tool Registry
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            Connect external workspaces, configure MCP JSON-RPC tool allowlists, and require explicit operator confirmation before any write or publish operation.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="px-2.5 py-1 rounded bg-slate-100 border border-slate-200 text-slate-700">
            Connected:{' '}
            {integrations.filter((i) => i.status === 'connected').length} /{' '}
            {integrations.length}
          </span>
          <span className="px-2.5 py-1 rounded bg-blue-50 border border-blue-200 text-blue-800">
            Audit Events: {auditLogs.length}
          </span>
        </div>
      </div>

      {statusFeedback && (
        <div
          className={`p-3 rounded-md border text-xs flex items-center justify-between ${
            statusFeedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <span className="font-medium">{statusFeedback.message}</span>
          <button
            onClick={() => setStatusFeedback(null)}
            className="text-xs underline ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Confirmation Modal for Write/Publish MCP Tools */}
      {pendingConfirmTool && (
        <div className="bg-amber-50 border-2 border-amber-400 rounded-md p-4 space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-amber-900">
              Mandatory Operator Confirmation Required (Write / Publish Action)
            </span>
            <span className="text-xs font-mono bg-amber-200/80 text-amber-950 px-2 py-0.5 rounded">
              {pendingConfirmTool.toolName}
            </span>
          </div>
          <p className="text-xs text-slate-800">
            You are about to execute{' '}
            <strong className="font-mono">{pendingConfirmTool.toolName}</strong> on{' '}
            <strong>{pendingConfirmTool.providerName}</strong> for project{' '}
            <strong>{bundle.project.name}</strong> ({bundle.assets.length} written assets,{' '}
            {bundle.clips.length} short clips).
          </p>
          <p className="text-[11px] text-slate-600">{pendingConfirmTool.description}</p>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() =>
                executeTool({
                  providerId: pendingConfirmTool.providerId,
                  toolName: pendingConfirmTool.toolName,
                  userConfirmed: true,
                })
              }
              className="text-xs font-semibold px-3 py-1.5 rounded bg-slate-900 text-white hover:bg-slate-800"
            >
              Confirm & Execute Write Action
            </button>
            <button
              type="button"
              onClick={() => setPendingConfirmTool(null)}
              className="text-xs font-semibold px-3 py-1.5 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Provider Directory */}
        <div className="lg:col-span-5 space-y-2.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Supported Connectors & MCP Bridges
          </h3>
          {integrations.map((item) => {
            const isSelected = item.providerId === activeIntegration?.providerId;
            return (
              <div
                key={item.providerId}
                onClick={() => setSelectedProvider(item.providerId)}
                className={`p-3.5 rounded-md border cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-900 border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-bold text-sm">{item.name}</div>
                  <span
                    className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-semibold ${
                      item.status === 'connected'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
                <p
                  className={`text-xs mt-1 ${
                    isSelected ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  {item.description}
                </p>
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-200/20 text-[11px] font-mono">
                  <span className={isSelected ? 'text-slate-400' : 'text-slate-500'}>
                    Auth: {item.authType}
                  </span>
                  <span className={isSelected ? 'text-blue-300' : 'text-slate-600'}>
                    {item.mcpTools.length} MCP tools
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right: Active Integration Configuration & MCP Tool Allowlist */}
        <div className="lg:col-span-7 space-y-5">
          {activeIntegration && (
            <div className="bg-white border border-slate-200 rounded-md p-5 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-slate-900">
                      {activeIntegration.name}
                    </h3>
                    <span
                      className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-semibold ${
                        activeIntegration.status === 'connected'
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-slate-100 text-slate-600 border border-slate-200'
                      }`}
                    >
                      {activeIntegration.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    {activeIntegration.description}
                  </p>
                  {activeIntegration.accountLabel && (
                    <div className="text-xs font-mono text-emerald-700 mt-1">
                      Active Binding: {activeIntegration.accountLabel}
                    </div>
                  )}
                </div>

                {activeIntegration.status === 'connected' &&
                  activeIntegration.providerId !== 'ai_provider' && (
                    <button
                      type="button"
                      onClick={() => handleDisconnect(activeIntegration.providerId)}
                      disabled={busyProvider === activeIntegration.providerId}
                      className="text-xs font-semibold px-3 py-1.5 rounded border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                    >
                      Disconnect
                    </button>
                  )}
              </div>

              {/* Connection Credential / Endpoint Form */}
              <div className="bg-slate-50 border border-slate-200 rounded p-4 space-y-3">
                <div className="text-xs font-bold text-slate-800">
                  {activeIntegration.status === 'connected'
                    ? 'Update Endpoint / Access Credentials'
                    : 'Connect & Verify Endpoint / Credentials'}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      {activeIntegration.authType === 'mcp_endpoint'
                        ? 'MCP JSON-RPC Server URL'
                        : activeIntegration.authType === 'webhook'
                          ? 'Incoming Webhook URL'
                          : 'OAuth Bearer Token / API Key'}
                    </label>
                    <input
                      type="text"
                      value={credentialInput}
                      onChange={(e) => setCredentialInput(e.target.value)}
                      placeholder={
                        activeIntegration.authType === 'mcp_endpoint'
                          ? 'http://localhost:4100/mcp'
                          : activeIntegration.authType === 'webhook'
                            ? 'https://hooks.slack.com/services/...'
                            : 'Enter token or API key...'
                      }
                      className="w-full text-xs border border-slate-300 rounded px-2.5 py-1.5 bg-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Workspace / Account Label (Optional)
                    </label>
                    <input
                      type="text"
                      value={accountLabelInput}
                      onChange={(e) => setAccountLabelInput(e.target.value)}
                      placeholder="e.g. Editorial Production Workspace"
                      className="w-full text-xs border border-slate-300 rounded px-2.5 py-1.5 bg-white"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px] text-slate-500">
                    All credentials and tokens are stored server-side and never exposed in client logs.
                  </span>
                  <button
                    type="button"
                    onClick={() => handleConnect(activeIntegration.providerId)}
                    disabled={busyProvider === activeIntegration.providerId}
                    className="text-xs font-semibold px-3.5 py-1.5 rounded bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {busyProvider === activeIntegration.providerId
                      ? 'Verifying...'
                      : activeIntegration.status === 'connected'
                        ? 'Re-Verify Connection'
                        : 'Connect & Verify'}
                  </button>
                </div>
              </div>

              {/* MCP Tool Registry & Allowlist */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                    Registered MCP Tools & Permission Controls
                  </h4>
                  <span className="text-[11px] text-slate-500">
                    Write/Publish tools require explicit confirmation
                  </span>
                </div>

                <div className="divide-y divide-slate-200 border border-slate-200 rounded">
                  {activeIntegration.mcpTools.map((tool) => (
                    <div
                      key={tool.name}
                      className="p-3 flex flex-wrap items-center justify-between gap-3 bg-white"
                    >
                      <div className="space-y-0.5 max-w-md">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold text-slate-900">
                            {tool.name}
                          </span>
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                              tool.category === 'read'
                                ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                : 'bg-amber-50 text-amber-800 border border-amber-200'
                            }`}
                          >
                            {tool.category}
                          </span>
                          {tool.requiresConfirmation && (
                            <span className="text-[10px] font-mono text-slate-500">
                              [Requires Confirmation]
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-600">{tool.description}</p>
                      </div>

                      <div className="flex items-center gap-2.5">
                        <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={tool.allowed}
                            onChange={() =>
                              toggleToolAllowlist(activeIntegration, tool.name)
                            }
                          />
                          Allowed
                        </label>

                        <button
                          type="button"
                          disabled={
                            !tool.allowed ||
                            activeIntegration.status !== 'connected' ||
                            busyProvider ===
                              `${activeIntegration.providerId}:${tool.name}`
                          }
                          onClick={() => {
                            if (tool.requiresConfirmation) {
                              setPendingConfirmTool({
                                providerId: activeIntegration.providerId,
                                providerName: activeIntegration.name,
                                toolName: tool.name,
                                description: tool.description,
                              });
                            } else {
                              void executeTool({
                                providerId: activeIntegration.providerId,
                                toolName: tool.name,
                                userConfirmed: false,
                              });
                            }
                          }}
                          className="text-xs font-semibold px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
                        >
                          {busyProvider ===
                          `${activeIntegration.providerId}:${tool.name}`
                            ? 'Running...'
                            : 'Invoke Tool'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Audit Log */}
          <div className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                MCP & Integration Execution Audit Log
              </h4>
              <span className="text-[11px] font-mono text-slate-500">
                Showing latest {auditLogs.length} events
              </span>
            </div>
            {auditLogs.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">
                No external tool invocations recorded yet. Connect a provider or run an allowed MCP tool above.
              </p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {auditLogs.map((log) => (
                  <div
                    key={log.id}
                    className="p-2.5 rounded bg-slate-50 border border-slate-200 text-xs flex flex-wrap items-center justify-between gap-2"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full ${
                            log.status === 'success'
                              ? 'bg-emerald-500'
                              : 'bg-rose-500'
                          }`}
                        />
                        <span className="font-mono font-bold text-slate-900">
                          {log.providerId} → {log.toolName}
                        </span>
                        {log.userConfirmed && (
                          <span className="text-[10px] font-mono bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">
                            Operator Confirmed
                          </span>
                        )}
                      </div>
                      <p className="text-slate-700">{log.actionSummary}</p>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
