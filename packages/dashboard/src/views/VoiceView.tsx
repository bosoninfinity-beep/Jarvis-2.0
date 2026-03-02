/**
 * VoiceView — Jarvis Voice Interface
 *
 * Full-featured voice control panel:
 * - Animated microphone orb with audio level visualization
 * - Real-time transcript display
 * - Conversation history with Jarvis responses
 * - Language toggle (PL/EN)
 * - TTS provider selection (ElevenLabs/OpenAI/Browser)
 * - Voice settings panel
 * - Wake word support ("Jarvis...")
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Mic, Volume2, VolumeX, Settings, Trash2, Globe,
  MessageSquare, AudioWaveform,
  Send,
} from 'lucide-react';
import { useVoiceStore, type VoiceLanguage, type TTSProvider } from '../store/voice-store.js';
import { useVoiceRecognition } from '../hooks/useVoiceRecognition.js';
import { useVoiceSynthesis } from '../hooks/useVoiceSynthesis.js';
import { gateway } from '../gateway/client.js';

// --- Inject keyframes ---
const VOICE_CSS = `
@keyframes voicePulse {
  0%, 100% { box-shadow: 0 0 20px rgba(0,255,65,0.3), inset 0 0 20px rgba(0,255,65,0.1); }
  50% { box-shadow: 0 0 60px rgba(0,255,65,0.8), inset 0 0 40px rgba(0,255,65,0.3); }
}
@keyframes voiceRipple {
  0% { transform: scale(1); opacity: 0.6; }
  100% { transform: scale(2.5); opacity: 0; }
}
@keyframes voiceGlow {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.4); }
}
@keyframes processingDots {
  0%, 20% { opacity: 0; }
  50% { opacity: 1; }
  80%, 100% { opacity: 0; }
}
@keyframes waveBar {
  0%, 100% { transform: scaleY(0.3); }
  50% { transform: scaleY(1); }
}
@keyframes speakingPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}
`;

export function VoiceView() {
  const status = useVoiceStore((s) => s.status);
  const messages = useVoiceStore((s) => s.messages);
  const currentTranscript = useVoiceStore((s) => s.currentTranscript);
  const interimTranscript = useVoiceStore((s) => s.interimTranscript);
  const error = useVoiceStore((s) => s.error);
  const settings = useVoiceStore((s) => s.settings);
  const audioLevel = useVoiceStore((s) => s.audioLevel);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const updateSettings = useVoiceStore((s) => s.updateSettings);
  const addMessage = useVoiceStore((s) => s.addMessage);
  const clearMessages = useVoiceStore((s) => s.clearMessages);
  const setMuted = useVoiceStore((s) => s.setMuted);
  const clearError = useVoiceStore((s) => s.clearError);
  const setStatus = useVoiceStore((s) => s.setStatus);

  const { toggleListening, startListening, stopListening } = useVoiceRecognition();
  const { speak, stopSpeaking } = useVoiceSynthesis();

  const [showSettings, setShowSettings] = useState(false);
  const [textInput, setTextInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef(false);
  const processedIdsRef = useRef<Set<string>>(new Set());
  const lastJarvisReplyRef = useRef<string>('');
  const ttsFinishedAtRef = useRef<number>(0);

  // Inject CSS
  useEffect(() => {
    const styleId = 'voice-orb-styles';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = VOICE_CSS;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Echo detection — check if user input is just Jarvis TTS echo
  const isEchoOrDuplicate = useCallback((text: string): boolean => {
    const trimmed = text.trim().toLowerCase();
    const lastReply = lastJarvisReplyRef.current.trim().toLowerCase();

    // Empty or very short (likely noise)
    if (trimmed.length < 3) return true;

    // Exact match with last Jarvis reply
    if (lastReply && trimmed === lastReply) return true;

    // Significant overlap with last Jarvis reply (mic echo — partial pickup)
    if (lastReply && lastReply.length > 10) {
      // Check if user input is a substring of Jarvis reply (echo)
      if (lastReply.includes(trimmed)) return true;
      // Check if Jarvis reply is a substring of user input
      if (trimmed.includes(lastReply)) return true;
      // Check word overlap — if >60% of words match, likely echo
      const userWords = new Set(trimmed.split(/\s+/));
      const replyWords = lastReply.split(/\s+/);
      const overlap = replyWords.filter((w) => userWords.has(w)).length;
      if (replyWords.length > 3 && overlap / replyWords.length > 0.6) return true;
    }

    // Too soon after TTS finished (echo still in microphone)
    const timeSinceTTS = Date.now() - ttsFinishedAtRef.current;
    if (timeSinceTTS < 1500) return true;

    return false;
  }, []);

  // Process user messages — send to Jarvis and get response
  const processUserMessage = useCallback(async (content: string, messageId: string) => {
    // Guard: already processing or already processed this message
    if (processingRef.current) return;
    if (processedIdsRef.current.has(messageId)) return;
    processedIdsRef.current.add(messageId);

    // Guard: echo/duplicate detection
    if (isEchoOrDuplicate(content)) {
      return;
    }

    processingRef.current = true;

    // Stop listening while processing + speaking
    stopListening();
    setStatus('processing');

    let reply: string;

    try {
      const response = await gateway.request<{ reply: string; agentId?: string }>('voice.process', {
        message: content,
        language: settings.language,
      });
      reply = response?.reply || getLocalResponse(content, settings.language);
    } catch {
      reply = getLocalResponse(content, settings.language);
    }

    // Remember Jarvis reply for echo detection
    lastJarvisReplyRef.current = reply;

    // Add Jarvis response
    addMessage({
      role: 'jarvis',
      content: reply,
      language: settings.language,
    });

    // Speak the response (this will set status to 'speaking' then 'idle')
    try {
      await speak({
        text: reply,
        language: settings.language,
      });
    } catch {
      // TTS failed — continue anyway
    }

    // Mark TTS finish time for echo detection
    ttsFinishedAtRef.current = Date.now();
    processingRef.current = false;

    // Auto-restart listening after response (if autoListen)
    // Wait 1200ms to avoid picking up TTS echo from speakers
    if (settings.autoListen) {
      setTimeout(() => {
        if (!processingRef.current) {
          startListening();
        }
      }, 1200);
    }
  }, [settings.language, settings.autoListen, addMessage, speak, setStatus, stopListening, startListening, isEchoOrDuplicate]);

  // Watch for new user messages — with deduplication
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'user' && !processingRef.current && !processedIdsRef.current.has(lastMsg.id)) {
      processUserMessage(lastMsg.content, lastMsg.id);
    }
  }, [messages.length, processUserMessage]);

  // Text input submit
  const handleTextSubmit = () => {
    const text = textInput.trim();
    if (!text) return;
    addMessage({ role: 'user', content: text, language: settings.language });
    setTextInput('');
  };

  const orbSize = 180;

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'linear-gradient(180deg, #0a0e14 0%, #060910 50%, #0a0e14 100%)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 24px',
        borderBottom: '1px solid var(--border-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <AudioWaveform size={20} color="var(--green-bright)" />
          <span style={{
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: 3,
            color: 'var(--green-bright)',
            textShadow: 'var(--glow-green)',
          }}>
            VOICE INTERFACE
          </span>
          <span style={{
            fontSize: 9,
            padding: '2px 8px',
            background: status === 'listening' ? 'rgba(0,255,65,0.15)' :
                       status === 'speaking' ? 'rgba(0,200,255,0.15)' :
                       status === 'processing' ? 'rgba(255,200,0,0.15)' : 'var(--bg-tertiary)',
            border: `1px solid ${status === 'listening' ? 'var(--green-dim)' :
                    status === 'speaking' ? 'rgba(0,200,255,0.3)' :
                    status === 'processing' ? 'rgba(255,200,0,0.3)' : 'var(--border-dim)'}`,
            borderRadius: 4,
            color: status === 'listening' ? 'var(--green-bright)' :
                   status === 'speaking' ? '#00c8ff' :
                   status === 'processing' ? '#ffc800' : 'var(--text-muted)',
            fontFamily: 'var(--font-display)',
            letterSpacing: 1.5,
            textTransform: 'uppercase',
          }}>
            {status}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Language toggle */}
          <button
            onClick={() => updateSettings({ language: settings.language === 'pl' ? 'en' : 'pl' })}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 4,
              background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
              color: 'var(--green-bright)', cursor: 'pointer',
              fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 1,
            }}
          >
            <Globe size={12} />
            {settings.language.toUpperCase()}
          </button>

          {/* Mute toggle */}
          <button
            onClick={() => setMuted(!isMuted)}
            style={{
              display: 'flex', alignItems: 'center', padding: 6, borderRadius: 4,
              background: isMuted ? 'rgba(255,60,60,0.1)' : 'var(--bg-tertiary)',
              border: `1px solid ${isMuted ? 'rgba(255,60,60,0.3)' : 'var(--border-dim)'}`,
              color: isMuted ? '#ff3c3c' : 'var(--text-muted)', cursor: 'pointer',
            }}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>

          {/* Settings */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              display: 'flex', alignItems: 'center', padding: 6, borderRadius: 4,
              background: showSettings ? 'rgba(0,255,65,0.1)' : 'var(--bg-tertiary)',
              border: `1px solid ${showSettings ? 'var(--green-dim)' : 'var(--border-dim)'}`,
              color: showSettings ? 'var(--green-bright)' : 'var(--text-muted)', cursor: 'pointer',
            }}
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Settings panel (collapsible) */}
      {showSettings && <SettingsPanel />}

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Voice orb + status */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px 24px 16px',
          position: 'relative',
        }}>
          {/* Ripple effects when listening */}
          {status === 'listening' && (
            <>
              <div style={{
                position: 'absolute',
                width: orbSize, height: orbSize, borderRadius: '50%',
                border: '2px solid rgba(0,255,65,0.3)',
                animation: 'voiceRipple 2s ease-out infinite',
              }} />
              <div style={{
                position: 'absolute',
                width: orbSize, height: orbSize, borderRadius: '50%',
                border: '2px solid rgba(0,255,65,0.2)',
                animation: 'voiceRipple 2s ease-out infinite 0.5s',
              }} />
              <div style={{
                position: 'absolute',
                width: orbSize, height: orbSize, borderRadius: '50%',
                border: '2px solid rgba(0,255,65,0.1)',
                animation: 'voiceRipple 2s ease-out infinite 1s',
              }} />
            </>
          )}

          {/* The Orb */}
          <button
            onClick={() => {
              if (status === 'speaking') {
                stopSpeaking();
              } else if (status === 'processing') {
                // Can't interrupt processing
              } else {
                toggleListening();
              }
            }}
            style={{
              width: orbSize,
              height: orbSize,
              borderRadius: '50%',
              border: `2px solid ${status === 'listening' ? 'var(--green-bright)' :
                      status === 'speaking' ? '#00c8ff' :
                      status === 'processing' ? '#ffc800' : 'var(--border-primary)'}`,
              background: status === 'listening'
                ? `radial-gradient(circle, rgba(0,255,65,${0.1 + audioLevel * 0.4}) 0%, rgba(0,255,65,0.05) 70%, transparent 100%)`
                : status === 'speaking'
                  ? 'radial-gradient(circle, rgba(0,200,255,0.15) 0%, rgba(0,200,255,0.05) 70%, transparent 100%)'
                  : status === 'processing'
                    ? 'radial-gradient(circle, rgba(255,200,0,0.1) 0%, rgba(255,200,0,0.03) 70%, transparent 100%)'
                    : 'radial-gradient(circle, rgba(0,255,65,0.05) 0%, transparent 70%)',
              cursor: status === 'processing' ? 'wait' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              animation: status === 'listening' ? 'voicePulse 2s ease-in-out infinite' :
                        status === 'speaking' ? 'speakingPulse 1.5s ease-in-out infinite' : 'none',
              transition: 'all 0.3s ease',
              position: 'relative',
              zIndex: 2,
            }}
          >
            {/* Audio level bars inside orb */}
            {status === 'listening' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 40 }}>
                {Array.from({ length: 7 }).map((_, i) => {
                  const barHeight = Math.max(6, audioLevel * 40 * (1 - Math.abs(i - 3) / 4) + Math.random() * 8);
                  return (
                    <div
                      key={i}
                      style={{
                        width: 4,
                        height: barHeight,
                        background: 'var(--green-bright)',
                        borderRadius: 2,
                        boxShadow: 'var(--glow-green)',
                        transition: 'height 0.1s ease',
                      }}
                    />
                  );
                })}
              </div>
            )}

            {status === 'speaking' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 40 }}>
                {Array.from({ length: 9 }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: 3,
                      height: 30,
                      background: '#00c8ff',
                      borderRadius: 2,
                      boxShadow: '0 0 6px rgba(0,200,255,0.5)',
                      animation: `waveBar 0.8s ease-in-out ${i * 0.08}s infinite`,
                      transformOrigin: 'center',
                    }}
                  />
                ))}
              </div>
            )}

            {status === 'processing' && (
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: '#ffc800',
                      animation: `processingDots 1.2s ease-in-out ${i * 0.3}s infinite`,
                    }}
                  />
                ))}
              </div>
            )}

            {status === 'idle' && (
              <Mic size={48} strokeWidth={1.2} color="var(--green-bright)" style={{ opacity: 0.8 }} />
            )}

            {/* Status text inside orb */}
            <span style={{
              fontFamily: 'var(--font-display)',
              fontSize: 8,
              letterSpacing: 2,
              color: status === 'listening' ? 'var(--green-bright)' :
                     status === 'speaking' ? '#00c8ff' :
                     status === 'processing' ? '#ffc800' : 'var(--text-muted)',
              textTransform: 'uppercase',
              position: 'absolute',
              bottom: 20,
            }}>
              {status === 'idle' ? 'TAP TO SPEAK' :
               status === 'listening' ? 'LISTENING...' :
               status === 'speaking' ? 'SPEAKING...' : 'PROCESSING...'}
            </span>
          </button>

          {/* Transcript display */}
          {(currentTranscript || interimTranscript) && (
            <div style={{
              marginTop: 16,
              padding: '8px 16px',
              background: 'rgba(0,255,65,0.05)',
              border: '1px solid var(--green-dim)',
              borderRadius: 8,
              maxWidth: 500,
              textAlign: 'center',
            }}>
              {currentTranscript && (
                <span style={{ color: 'var(--green-bright)', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
                  {currentTranscript}
                </span>
              )}
              {interimTranscript && (
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: 14, fontStyle: 'italic' }}>
                  {interimTranscript}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Conversation history */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 24px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          {messages.length === 0 && status === 'idle' && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 40,
              opacity: 0.4,
              gap: 8,
            }}>
              <MessageSquare size={32} color="var(--text-muted)" />
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--text-muted)', letterSpacing: 2 }}>
                {settings.language === 'pl' ? 'KLIKNIJ I MÓWI' : 'TAP AND TALK'}
              </span>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div style={{
                maxWidth: '75%',
                padding: '10px 16px',
                borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                background: msg.role === 'user'
                  ? 'rgba(0,255,65,0.08)'
                  : 'rgba(0,200,255,0.06)',
                border: `1px solid ${msg.role === 'user' ? 'var(--green-dim)' : 'rgba(0,200,255,0.2)'}`,
              }}>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 8,
                  letterSpacing: 1.5,
                  color: msg.role === 'user' ? 'var(--green-muted)' : 'rgba(0,200,255,0.6)',
                  marginBottom: 4,
                  textTransform: 'uppercase',
                }}>
                  {msg.role === 'user' ? 'YOU' : 'JARVIS'} • {new Date(msg.timestamp).toLocaleTimeString()}
                </div>
                <div style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: msg.role === 'user' ? 'var(--green-bright)' : '#c8e6ff',
                }}>
                  {msg.content}
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Text input fallback */}
        <div style={{
          padding: '12px 24px',
          borderTop: '1px solid var(--border-primary)',
          display: 'flex',
          gap: 8,
        }}>
          <input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleTextSubmit()}
            placeholder={settings.language === 'pl' ? 'Wpisz komendę...' : 'Type a command...'}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-dim)',
              borderRadius: 6,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-ui)',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <button
            onClick={handleTextSubmit}
            disabled={!textInput.trim()}
            style={{
              display: 'flex', alignItems: 'center', padding: '8px 12px',
              background: textInput.trim() ? 'rgba(0,255,65,0.1)' : 'var(--bg-tertiary)',
              border: `1px solid ${textInput.trim() ? 'var(--green-dim)' : 'var(--border-dim)'}`,
              borderRadius: 6,
              color: textInput.trim() ? 'var(--green-bright)' : 'var(--text-muted)',
              cursor: textInput.trim() ? 'pointer' : 'default',
            }}
          >
            <Send size={14} />
          </button>
          <button
            onClick={clearMessages}
            style={{
              display: 'flex', alignItems: 'center', padding: '8px',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
              borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer',
            }}
            title="Clear conversation"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {/* Error display */}
        {error && (
          <div style={{
            padding: '8px 24px',
            background: 'rgba(255,60,60,0.08)',
            borderTop: '1px solid rgba(255,60,60,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: '#ff6060' }}>
              {error}
            </span>
            <button
              onClick={clearError}
              style={{
                background: 'none', border: 'none', color: '#ff6060',
                cursor: 'pointer', fontSize: 11, textDecoration: 'underline',
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Settings Panel ---

function SettingsPanel() {
  const settings = useVoiceStore((s) => s.settings);
  const updateSettings = useVoiceStore((s) => s.updateSettings);

  const inputStyle = {
    width: '100%',
    padding: '6px 10px',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-dim)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    outline: 'none',
  };

  const labelStyle = {
    fontFamily: 'var(--font-display)',
    fontSize: 9,
    letterSpacing: 1,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    marginBottom: 4,
  };

  return (
    <div style={{
      padding: '16px 24px',
      borderBottom: '1px solid var(--border-primary)',
      background: 'rgba(0,0,0,0.3)',
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap: 16,
    }}>
      {/* TTS Provider */}
      <div>
        <div style={labelStyle}>TTS Provider</div>
        <select
          value={settings.ttsProvider}
          onChange={(e) => updateSettings({ ttsProvider: e.target.value as TTSProvider })}
          style={inputStyle}
        >
          <option value="elevenlabs">ElevenLabs (Best Quality)</option>
          <option value="openai">OpenAI TTS</option>
          <option value="browser">Browser (Free)</option>
        </select>
      </div>

      {/* ElevenLabs API Key */}
      {settings.ttsProvider === 'elevenlabs' && (
        <>
          <div>
            <div style={labelStyle}>ElevenLabs API Key</div>
            <input
              type="password"
              value={settings.elevenLabsApiKey}
              onChange={(e) => updateSettings({ elevenLabsApiKey: e.target.value })}
              placeholder="xi_..."
              style={inputStyle}
            />
          </div>
          <div>
            <div style={labelStyle}>Voice ID</div>
            <select
              value={settings.elevenLabsVoiceId}
              onChange={(e) => updateSettings({ elevenLabsVoiceId: e.target.value })}
              style={inputStyle}
            >
              <option value="onwK4e9ZLuTAKqWW03F9">Daniel (British Jarvis)</option>
              <option value="pNInz6obpgDQGcFmaJgB">Adam (Deep, Authoritative)</option>
              <option value="ErXwobaYiN019PkySvjV">Antoni (Warm, Professional)</option>
              <option value="VR6AewLTigWG4xSOukaG">Arnold (Deep, Commanding)</option>
              <option value="yoZ06aMxZJJ28mfd3POQ">Sam (Smooth, Technical)</option>
              <option value="29vD33N1CtxCmqQRPOHJ">Drew (Confident, Mature)</option>
              <option value="TxGEqnHWrfWFTfGW9XjX">Josh (Deep, Narrator)</option>
            </select>
          </div>
        </>
      )}

      {/* OpenAI Settings */}
      {settings.ttsProvider === 'openai' && (
        <>
          <div>
            <div style={labelStyle}>OpenAI API Key</div>
            <input
              type="password"
              value={settings.openaiApiKey}
              onChange={(e) => updateSettings({ openaiApiKey: e.target.value })}
              placeholder="sk-..."
              style={inputStyle}
            />
          </div>
          <div>
            <div style={labelStyle}>Voice</div>
            <select
              value={settings.openaiVoice}
              onChange={(e) => updateSettings({ openaiVoice: e.target.value })}
              style={inputStyle}
            >
              <option value="onyx">Onyx (Deep Male - Jarvis-like)</option>
              <option value="echo">Echo (Smooth Male)</option>
              <option value="fable">Fable (British Male)</option>
              <option value="alloy">Alloy (Neutral)</option>
              <option value="nova">Nova (Female)</option>
              <option value="shimmer">Shimmer (Warm Female)</option>
            </select>
          </div>
        </>
      )}

      {/* Speed */}
      <div>
        <div style={labelStyle}>Speed: {settings.speed.toFixed(1)}x</div>
        <input
          type="range"
          min="0.5"
          max="2.0"
          step="0.1"
          value={settings.speed}
          onChange={(e) => updateSettings({ speed: parseFloat(e.target.value) })}
          style={{ width: '100%', accentColor: 'var(--green-bright)' }}
        />
      </div>

      {/* Volume */}
      <div>
        <div style={labelStyle}>Volume: {Math.round(settings.volume * 100)}%</div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={settings.volume}
          onChange={(e) => updateSettings({ volume: parseFloat(e.target.value) })}
          style={{ width: '100%', accentColor: 'var(--green-bright)' }}
        />
      </div>

      {/* Toggles */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.autoListen}
            onChange={(e) => updateSettings({ autoListen: e.target.checked })}
            style={{ accentColor: 'var(--green-bright)' }}
          />
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-secondary)' }}>
            Auto-listen after response
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.wakeWordEnabled}
            onChange={(e) => updateSettings({ wakeWordEnabled: e.target.checked })}
            style={{ accentColor: 'var(--green-bright)' }}
          />
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-secondary)' }}>
            Wake word: "{settings.wakeWord}"
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.continuousMode}
            onChange={(e) => updateSettings({ continuousMode: e.target.checked })}
            style={{ accentColor: 'var(--green-bright)' }}
          />
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-secondary)' }}>
            Continuous listening mode
          </span>
        </label>
      </div>
    </div>
  );
}

// --- Local fallback responses ---
function getLocalResponse(input: string, lang: VoiceLanguage): string {
  const lower = input.toLowerCase();

  if (lang === 'pl') {
    if (lower.includes('status') || lower.includes('jak') && lower.includes('system'))
      return 'Wszystko działa, systemy w porządku, oba agenty online.';
    if (lower.includes('agenci') || lower.includes('agent'))
      return 'Masz dwóch agentów — Smith robi dev, Johny zajmuje się marketingiem. Oba aktywne.';
    if (lower.includes('czas') || lower.includes('godzina') || lower.includes('która'))
      return `Jest ${new Date().toLocaleTimeString('pl-PL')}.`;
    if (lower.includes('dzień dobry') || lower.includes('cześć') || lower.includes('hej') || lower.includes('siema') || lower.includes('yo'))
      return 'Hej, co tam? Wszystko chodzi, mów co potrzebujesz.';
    if (lower.includes('dziękuję') || lower.includes('dzięki') || lower.includes('thx'))
      return 'Spoko, nie ma sprawy.';
    if (lower.includes('co potrafisz') || lower.includes('co umiesz') || lower.includes('pomoc'))
      return 'Ogarniam agentów, monitoruję system, planuję taski, workflow-y, i gadamy po polsku albo angielsku. Pytaj o co chcesz.';
    if (lower.includes('pogoda'))
      return 'Nie mam jeszcze modułu pogody, ale mogę podpiąć Open-Meteo jak chcesz.';
    if (lower.includes('kto') && (lower.includes('jesteś') || lower.includes('ty')))
      return 'Jarvis — zarządzam twoimi agentami AI, pilnuję infrastruktury i pomagam ogarnąć robotę.';
    if (lower.includes('dobranoc') || lower.includes('nara') || lower.includes('pa'))
      return 'Nara, gdyby coś — jestem tu.';
    if (lower.includes('kurwa') || lower.includes('cholera') || lower.includes('szlag'))
      return 'Spokojnie, co się stało? Mów, pomogę ogarnąć.';
    if (lower.includes('otwórz') || lower.includes('odpal') || lower.includes('puść') || lower.includes('włącz'))
      return 'Jeszcze nie mam modułu do otwierania aplikacji — dodam automatyzację przeglądarki wkrótce.';
    if (lower.includes('muzyk') || lower.includes('spotify') || lower.includes('youtube'))
      return 'Muzyka jeszcze nie podpięta, ale mogę dodać Spotify albo YouTube — daj znać.';
    return 'Nie mam jeszcze handlera na to. Pytaj o status, agentów, taski albo czas.';
  }

  // English
  if (lower.includes('status') || (lower.includes('how') && lower.includes('system')))
    return 'Everything\'s running fine, both agents are online.';
  if (lower.includes('agents') || lower.includes('agent'))
    return 'You\'ve got Smith on dev and Johny on marketing. Both active.';
  if (lower.includes('time'))
    return `It's ${new Date().toLocaleTimeString('en-US')}.`;
  if (lower.includes('hello') || lower.includes('hey') || lower.includes('hi ') || lower === 'hi' || lower.includes('yo'))
    return 'Hey, what\'s up? Systems are good, what do you need?';
  if (lower.includes('thank'))
    return 'No worries.';
  if (lower.includes('who are you') || lower.includes('what are you'))
    return 'I\'m Jarvis — I manage your AI agents, watch the infrastructure, and help get stuff done.';
  if (lower.includes('help') || lower.includes('what can you do'))
    return 'I handle agents, monitor systems, plan tasks, run workflows. Ask me anything.';
  if (lower.includes('weather'))
    return 'Don\'t have a weather module yet, but I can hook up Open-Meteo if you want.';
  if (lower.includes('open') && (lower.includes('youtube') || lower.includes('spotify') || lower.includes('music')))
    return 'I can\'t open apps directly yet — that needs browser automation. I\'ll add it soon.';
  if (lower.includes('music') || lower.includes('play'))
    return 'Music playback isn\'t wired up yet, but it\'s on the list. I could hook up Spotify or YouTube controls.';
  if (lower.includes('bye') || lower.includes('goodnight'))
    return 'Later. I\'ll be here if you need anything.';
  return 'Hmm, I don\'t have a handler for that yet. Try asking about status, agents, tasks, or time.';
}
