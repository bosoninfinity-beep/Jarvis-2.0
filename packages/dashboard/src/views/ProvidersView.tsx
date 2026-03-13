/**
 * ProvidersView — LLM Model Provider Configuration
 *
 * Inspired by OpenClaw's model failover chain system.
 * Configure multiple LLM providers, set failover chains,
 * and manage API keys for each provider.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Cpu,
  Check,
  ChevronDown,
  ChevronUp,
  Zap,
  AlertCircle,
  ArrowDown,
  Shield,
  DollarSign,
  Clock,
  Server,
} from 'lucide-react';
import { gateway } from '../gateway/client.js';

interface ModelProvider {
  id: string;
  name: string;
  type: 'anthropic' | 'openai' | 'google' | 'ollama' | 'bedrock' | 'custom';
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: ModelDef[];
  priority: number; // Lower = higher priority (for failover)
}

interface ModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  inputCost: number;  // per 1M tokens
  outputCost: number; // per 1M tokens
  reasoning: boolean;
  vision: boolean;
}

interface FailoverChain {
  id: string;
  name: string;
  description: string;
  models: string[]; // model IDs in order
  active: boolean;
}

const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    enabled: true,
    priority: 1,
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000, maxTokens: 128000, inputCost: 5, outputCost: 25, reasoning: true, vision: true },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxTokens: 64000, inputCost: 3, outputCost: 15, reasoning: true, vision: true },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 64000, inputCost: 1, outputCost: 5, reasoning: true, vision: true },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    enabled: false,
    priority: 2,
    models: [
      { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 400000, maxTokens: 128000, inputCost: 1.75, outputCost: 14, reasoning: true, vision: true },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', contextWindow: 400000, maxTokens: 128000, inputCost: 0.25, outputCost: 2, reasoning: false, vision: true },
      { id: 'o3', name: 'o3', contextWindow: 200000, maxTokens: 100000, inputCost: 2, outputCost: 8, reasoning: true, vision: true },
    ],
  },
  {
    id: 'google',
    name: 'Google AI',
    type: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    enabled: false,
    priority: 3,
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1000000, maxTokens: 8192, inputCost: 0.075, outputCost: 0.3, reasoning: false, vision: true },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000, maxTokens: 65536, inputCost: 1.25, outputCost: 10, reasoning: true, vision: true },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    enabled: false,
    priority: 4,
    models: [
      { id: 'llama3.1:70b', name: 'Llama 3.1 70B', contextWindow: 128000, maxTokens: 8192, inputCost: 0, outputCost: 0, reasoning: false, vision: false },
      { id: 'deepseek-coder-v2', name: 'DeepSeek Coder V2', contextWindow: 128000, maxTokens: 8192, inputCost: 0, outputCost: 0, reasoning: false, vision: false },
      { id: 'qwen2.5:32b', name: 'Qwen 2.5 32B', contextWindow: 128000, maxTokens: 8192, inputCost: 0, outputCost: 0, reasoning: false, vision: false },
    ],
  },
];

const DEFAULT_CHAINS: FailoverChain[] = [
  {
    id: 'default',
    name: 'Default Chain',
    description: 'Primary model with cost-effective fallback',
    models: ['claude-sonnet-4-6', 'gpt-5.2', 'gemini-2.0-flash'],
    active: true,
  },
  {
    id: 'reasoning',
    name: 'Reasoning Chain',
    description: 'For complex tasks requiring deep thinking',
    models: ['claude-opus-4-6', 'o3', 'gemini-2.5-pro'],
    active: false,
  },
  {
    id: 'fast',
    name: 'Fast & Cheap',
    description: 'Quick responses, minimal cost',
    models: ['claude-haiku-4-5-20251001', 'gpt-5-mini', 'gemini-2.0-flash'],
    active: false,
  },
  {
    id: 'local',
    name: 'Local Only',
    description: 'Privacy-first — no data leaves your machine',
    models: ['llama3.1:70b', 'deepseek-coder-v2', 'qwen2.5:32b'],
    active: false,
  },
];

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#D97757',
  openai: '#10a37f',
  google: '#4285F4',
  ollama: '#ffffff',
  bedrock: '#FF9900',
  custom: 'var(--purple)',
};

export function ProvidersView() {
  const [providers, setProviders] = useState<ModelProvider[]>(DEFAULT_PROVIDERS);
  const [chains, setChains] = useState<FailoverChain[]>(DEFAULT_CHAINS);
  const [expandedChain, setExpandedChain] = useState<string | null>('default');
  // Load config from gateway
  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const result = await gateway.request('providers.config.get', {}) as {
        providers?: Array<Record<string, unknown>>;
        chains?: FailoverChain[];
        activeModel?: string;
      };

      // Merge gateway state with local catalog — gateway tracks enabled/apiKey,
      // catalog provides model definitions (static data)
      if (result?.providers?.length) {
        setProviders(prev => prev.map(local => {
          const remote = result.providers!.find((r: Record<string, unknown>) => r.id === local.id);
          if (!remote) return local;
          return {
            ...local,
            enabled: (remote.enabled as boolean) ?? local.enabled,
            apiKey: (remote.apiKey as string) ?? local.apiKey,
            priority: (remote.priority as number) ?? local.priority,
            baseUrl: (remote.baseUrl as string) ?? local.baseUrl,
            // Keep local models catalog (gateway doesn't store model defs)
            models: (remote as any).models?.length ? (remote as any).models : local.models,
          };
        }));
      }
      if (result?.chains?.length) setChains(result.chains);
    } catch { /* Use defaults */ }
  }, []);

  const saveConfig = async () => {
    try {
      await gateway.request('providers.config.set', {
        providers: providers.map(p => ({
          id: p.id, name: p.name, type: p.type,
          baseUrl: p.baseUrl, apiKey: p.apiKey,
          enabled: p.enabled, priority: p.priority,
          models: p.models,
        })),
        chains,
        activeModel: chains.find(c => c.active)?.models[0] ?? 'claude-sonnet-4-6',
      });
    } catch { /* */ }
  };

  const toggleProvider = (id: string) => {
    setProviders((prev) => prev.map((p) =>
      p.id === id ? { ...p, enabled: !p.enabled } : p
    ));
  };

  const setActiveChain = (chainId: string) => {
    setChains((prev) => prev.map((c) => ({ ...c, active: c.id === chainId })));
  };

  const allModels = providers.flatMap((p) => p.models.map((m) => ({
    ...m,
    providerId: p.id,
    providerName: p.name,
    providerEnabled: p.enabled,
  })));

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <Cpu size={20} color="var(--purple)" />
          <span style={{
            fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800,
            letterSpacing: 3, color: 'var(--purple)', textShadow: '0 0 10px #bf5af244',
          }}>
            MODEL PROVIDERS
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', maxWidth: 600, lineHeight: 1.6 }}>
          Configure LLM providers and failover chains. When a model fails, Jarvis automatically switches to the next model in the chain.
        </div>
      </div>

      {/* Auth Mode — Claude CLI (Max) only */}
      <div style={{
        marginBottom: 20, padding: 16, borderRadius: 12,
        background: 'linear-gradient(135deg, rgba(0,255,65,0.06), rgba(0,255,65,0.02))',
        border: '1px solid var(--green-primary)33',
      }}>
        <div style={{
          fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: 700,
          letterSpacing: 2, color: 'var(--text-secondary)', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Zap size={14} color="var(--green-bright)" />
          CLAUDE CLI (MAX)
          <span style={{
            fontSize: 8, padding: '1px 5px', borderRadius: 3, fontWeight: 700,
            background: 'rgba(0,255,65,0.15)', color: 'var(--green-bright)',
            fontFamily: 'var(--font-mono)', letterSpacing: 1,
          }}>FREE</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', lineHeight: 1.5 }}>
          Uses Max subscription — $0 per token. Same Opus 4.6 model via CLI subprocess.
        </div>
      </div>

      {/* Provider cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginBottom: 28 }}>
        {providers.map((provider) => {
          const color = PROVIDER_COLORS[provider.type] || 'var(--text-muted)';
          return (
            <div key={provider.id} style={{
              padding: 14, borderRadius: 10,
              background: provider.enabled
                ? `linear-gradient(135deg, ${color}08, ${color}04)`
                : 'var(--bg-secondary)',
              border: `1px solid ${provider.enabled ? `${color}33` : 'var(--border-dim)'}`,
              transition: 'all 0.2s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: `${color}15`, border: `1px solid ${color}33`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Server size={16} color={color} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-display)', letterSpacing: 1, color }}>
                      {provider.name}
                    </div>
                    <div style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      Priority #{provider.priority}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => toggleProvider(provider.id)}
                  style={{
                    width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
                    background: provider.enabled ? color : 'var(--bg-tertiary)',
                    border: `1px solid ${provider.enabled ? `${color}88` : 'var(--border-dim)'}`,
                    position: 'relative', transition: 'all 0.2s', padding: 0,
                  }}
                >
                  <div style={{
                    width: 14, height: 14, borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: 2, left: provider.enabled ? 19 : 2,
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>

              {/* API Key / Auth status */}
              <div style={{
                fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4,
              }}>
                {provider.type === 'anthropic' ? (
                  <><Shield size={8} color="var(--green-bright)" /> CLI (Max subscription)</>
                ) : provider.type === 'ollama' ? (
                  <><Server size={8} /> {provider.baseUrl}</>
                ) : provider.apiKey ? (
                  <><Shield size={8} color="var(--green-bright)" /> API Key configured</>
                ) : (
                  <><AlertCircle size={8} color="var(--amber)" /> No API key set</>
                )}
              </div>

              {/* Models */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {provider.models.map((model) => (
                  <span key={model.id} style={{
                    fontSize: 8, padding: '2px 6px', borderRadius: 3,
                    background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
                    color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)',
                    display: 'flex', alignItems: 'center', gap: 3,
                  }}>
                    {model.name}
                    {model.reasoning && <Zap size={7} color="var(--amber)" />}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Failover Chains */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 12, fontFamily: 'var(--font-display)', fontWeight: 700,
          letterSpacing: 2, color: 'var(--cyan-bright)', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <ArrowDown size={16} /> FAILOVER CHAINS
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {chains.map((chain) => (
            <div key={chain.id} style={{
              borderRadius: 10, overflow: 'hidden',
              background: chain.active
                ? 'linear-gradient(135deg, rgba(0,255,65,0.04), rgba(0,255,65,0.02))'
                : 'var(--bg-secondary)',
              border: `1px solid ${chain.active ? 'var(--green-primary)33' : 'var(--border-dim)'}`,
            }}>
              <div
                onClick={() => setExpandedChain(expandedChain === chain.id ? null : chain.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 16px', cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setActiveChain(chain.id); saveConfig(); }}
                    style={{
                      width: 18, height: 18, borderRadius: '50%', cursor: 'pointer',
                      background: chain.active ? 'var(--green-bright)' : 'transparent',
                      border: `2px solid ${chain.active ? 'var(--green-bright)' : 'var(--text-muted)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: 0, flexShrink: 0,
                    }}
                  >
                    {chain.active && <Check size={10} color="#000" />}
                  </button>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-display)', letterSpacing: 1, color: chain.active ? 'var(--green-bright)' : 'var(--text-primary)' }}>
                      {chain.name}
                      {chain.active && <span style={{ fontSize: 8, marginLeft: 6, color: 'var(--green-bright)', fontWeight: 400 }}>ACTIVE</span>}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>
                      {chain.description}
                    </div>
                  </div>
                </div>
                {expandedChain === chain.id ? <ChevronUp size={14} color="var(--text-muted)" /> : <ChevronDown size={14} color="var(--text-muted)" />}
              </div>

              {/* Expanded: show model chain */}
              {expandedChain === chain.id && (
                <div style={{ padding: '0 16px 14px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {chain.models.map((modelId, idx) => {
                    const model = allModels.find((m) => m.id === modelId);
                    const color = model ? PROVIDER_COLORS[model.providerId] || 'var(--text-muted)' : 'var(--text-muted)';
                    return (
                      <div key={modelId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{
                          padding: '6px 12px', borderRadius: 6,
                          background: `${color}10`, border: `1px solid ${color}33`,
                          display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                          <span style={{
                            fontSize: 8, fontFamily: 'var(--font-display)', letterSpacing: 1,
                            color: 'var(--text-muted)',
                          }}>
                            #{idx + 1}
                          </span>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, color, fontFamily: 'var(--font-ui)' }}>
                              {model?.name || modelId}
                            </div>
                            <div style={{ display: 'flex', gap: 8, fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              {model && (
                                <>
                                  <span>{model.providerName}</span>
                                  <span><DollarSign size={7} />${model.inputCost}/${model.outputCost}</span>
                                  <span><Clock size={7} />{(model.contextWindow / 1000).toFixed(0)}K ctx</span>
                                </>
                              )}
                              {!model?.providerEnabled && (
                                <span style={{ color: 'var(--amber)' }}>
                                  <AlertCircle size={7} /> Provider disabled
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        {idx < chain.models.length - 1 && (
                          <ArrowDown size={12} color="var(--text-muted)" style={{ opacity: 0.4, transform: 'rotate(-90deg)' }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Save button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20, paddingBottom: 20 }}>
        <button onClick={saveConfig} style={{
          padding: '10px 24px', fontSize: 11, fontFamily: 'var(--font-display)',
          fontWeight: 700, letterSpacing: 2, borderRadius: 6, cursor: 'pointer',
          background: 'linear-gradient(135deg, var(--purple), #8b5cf6)',
          border: 'none', color: '#fff',
          boxShadow: '0 0 15px rgba(139,92,246,0.2)',
        }}>
          SAVE CONFIGURATION
        </button>
      </div>
    </div>
  );
}
