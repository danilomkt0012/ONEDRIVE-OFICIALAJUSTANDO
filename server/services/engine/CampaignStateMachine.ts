import { logError } from '../../utils/logger';
/**
 * ============================================================================
 * MÁQUINA DE ESTADOS DA CAMPANHA
 * ============================================================================
 * 
 * Estados explícitos do ciclo de vida da campanha:
 * 
 * INIT → RUNNING → DEGRADED → PAUSED_BY_ENGINE → SAFE_MODE → RESUMING → FINALIZING → COMPLETED
 *                     ↓                              ↓
 *              FAILED_GRACEFULLY ←──────────────────┘
 * 
 * Cada transição é validada e registrada.
 * Eventos externos podem forçar transições.
 */

export type CampaignState = 
  | 'INIT'
  | 'RUNNING'
  | 'DEGRADED'
  | 'PAUSED_BY_ENGINE'
  | 'PAUSED_BY_USER'
  | 'SAFE_MODE'
  | 'RESUMING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED_GRACEFULLY'
  | 'FAILED';

export interface StateTransition {
  from: CampaignState;
  to: CampaignState;
  trigger: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface StateConfig {
  allowedTransitions: CampaignState[];
  onEnter?: () => void | Promise<void>;
  onExit?: () => void | Promise<void>;
  timeout?: number;
  autoTransition?: {
    to: CampaignState;
    after: number;
    condition?: () => boolean;
  };
}

export interface StateMachineSnapshot {
  currentState: CampaignState;
  previousState: CampaignState | null;
  stateEnteredAt: number;
  timeInState: number;
  transitionCount: number;
  history: StateTransition[];
  isTerminal: boolean;
  canResume: boolean;
}

type StateHandler = (machine: CampaignStateMachine, metadata?: Record<string, any>) => void | Promise<void>;

const TERMINAL_STATES: CampaignState[] = ['COMPLETED', 'FAILED_GRACEFULLY', 'FAILED'];
const RESUMABLE_STATES: CampaignState[] = ['PAUSED_BY_ENGINE', 'PAUSED_BY_USER', 'DEGRADED', 'SAFE_MODE'];

const STATE_TRANSITIONS: Record<CampaignState, CampaignState[]> = {
  'INIT': ['RUNNING', 'FAILED'],
  'RUNNING': ['DEGRADED', 'PAUSED_BY_ENGINE', 'PAUSED_BY_USER', 'SAFE_MODE', 'FINALIZING', 'FAILED_GRACEFULLY', 'FAILED'],
  'DEGRADED': ['RUNNING', 'PAUSED_BY_ENGINE', 'SAFE_MODE', 'FINALIZING', 'FAILED_GRACEFULLY'],
  'PAUSED_BY_ENGINE': ['RESUMING', 'SAFE_MODE', 'FAILED_GRACEFULLY', 'FAILED'],
  'PAUSED_BY_USER': ['RESUMING', 'FAILED_GRACEFULLY'],
  'SAFE_MODE': ['RESUMING', 'PAUSED_BY_ENGINE', 'FINALIZING', 'FAILED_GRACEFULLY'],
  'RESUMING': ['RUNNING', 'DEGRADED', 'SAFE_MODE', 'PAUSED_BY_ENGINE', 'FAILED_GRACEFULLY'],
  'FINALIZING': ['COMPLETED', 'FAILED_GRACEFULLY'],
  'COMPLETED': [],
  'FAILED_GRACEFULLY': [],
  'FAILED': []
};

export class CampaignStateMachine {
  private currentState: CampaignState = 'INIT';
  private previousState: CampaignState | null = null;
  private stateEnteredAt: number = Date.now();
  private history: StateTransition[] = [];
  private maxHistorySize: number = 100;
  
  // Callbacks
  private onTransitionCallback?: (transition: StateTransition) => void;
  private stateHandlers: Map<CampaignState, StateHandler[]> = new Map();
  
  // Auto-transition timers
  private autoTransitionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.stateEnteredAt = Date.now();
  }

  /**
   * Registra callback para transições
   */
  onTransition(callback: (transition: StateTransition) => void): void {
    this.onTransitionCallback = callback;
  }

  /**
   * Registra handler para estado específico
   */
  onState(state: CampaignState, handler: StateHandler): void {
    const handlers = this.stateHandlers.get(state) || [];
    handlers.push(handler);
    this.stateHandlers.set(state, handlers);
  }

  /**
   * Tenta transição para novo estado
   */
  async transition(to: CampaignState, trigger: string, metadata?: Record<string, any>): Promise<boolean> {
    // Validate transition
    const allowedTransitions = STATE_TRANSITIONS[this.currentState];
    if (!allowedTransitions.includes(to)) {
      console.warn(`[StateMachine] Transição inválida: ${this.currentState} → ${to} (trigger: ${trigger})`);
      return false;
    }
    
    // Record transition
    const transition: StateTransition = {
      from: this.currentState,
      to,
      trigger,
      timestamp: Date.now(),
      metadata
    };
    
    // Clear any pending auto-transition
    if (this.autoTransitionTimer) {
      clearTimeout(this.autoTransitionTimer);
      this.autoTransitionTimer = null;
    }
    
    // Update state
    this.previousState = this.currentState;
    this.currentState = to;
    this.stateEnteredAt = Date.now();
    
    // Record history
    this.history.push(transition);
    while (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
    
    // Log transition
    const stateEmoji: Record<CampaignState, string> = {
      'INIT': '🔄',
      'RUNNING': '▶️',
      'DEGRADED': '⚠️',
      'PAUSED_BY_ENGINE': '⏸️',
      'PAUSED_BY_USER': '⏸️',
      'SAFE_MODE': '🛡️',
      'RESUMING': '🔄',
      'FINALIZING': '⏳',
      'COMPLETED': '✅',
      'FAILED_GRACEFULLY': '🔶',
      'FAILED': '❌'
    };
    
    console.log(`\n${stateEmoji[to]} Campanha: ${this.previousState} → ${to}`);
    console.log(`   Trigger: ${trigger}`);
    if (metadata) {
      console.log(`   Metadata: ${JSON.stringify(metadata)}`);
    }
    
    // Trigger callbacks
    this.onTransitionCallback?.(transition);
    
    // Execute state handlers
    const handlers = this.stateHandlers.get(to) || [];
    for (const handler of handlers) {
      await handler(this, metadata);
    }
    
    return true;
  }

  /**
   * Força transição (bypass validation)
   */
  async forceTransition(to: CampaignState, trigger: string, metadata?: Record<string, any>): Promise<void> {
    const transition: StateTransition = {
      from: this.currentState,
      to,
      trigger: `FORCED: ${trigger}`,
      timestamp: Date.now(),
      metadata
    };
    
    this.previousState = this.currentState;
    this.currentState = to;
    this.stateEnteredAt = Date.now();
    this.history.push(transition);
    
    console.log(`\n⚠️ Campanha: FORÇADO ${this.previousState} → ${to} (${trigger})`);
    
    this.onTransitionCallback?.(transition);
  }

  /**
   * Agenda auto-transição após timeout
   */
  scheduleAutoTransition(to: CampaignState, afterMs: number, trigger: string): void {
    if (this.autoTransitionTimer) {
      clearTimeout(this.autoTransitionTimer);
    }
    
    this.autoTransitionTimer = setTimeout(async () => {
      await this.transition(to, trigger);
    }, afterMs);
  }

  /**
   * Retorna estado atual
   */
  getState(): CampaignState {
    return this.currentState;
  }

  /**
   * Retorna estado anterior
   */
  getPreviousState(): CampaignState | null {
    return this.previousState;
  }

  /**
   * Verifica se está em estado terminal
   */
  isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.currentState);
  }

  /**
   * Verifica se pode ser resumido
   */
  canResume(): boolean {
    return RESUMABLE_STATES.includes(this.currentState);
  }

  /**
   * Verifica se está rodando
   */
  isRunning(): boolean {
    return this.currentState === 'RUNNING';
  }

  /**
   * Verifica se está em safe mode
   */
  isInSafeMode(): boolean {
    return this.currentState === 'SAFE_MODE';
  }

  /**
   * Verifica se está pausado
   */
  isPaused(): boolean {
    return this.currentState === 'PAUSED_BY_ENGINE' || this.currentState === 'PAUSED_BY_USER';
  }

  /**
   * Verifica se está finalizando
   */
  isFinalizing(): boolean {
    return this.currentState === 'FINALIZING';
  }

  /**
   * Verifica se completou
   */
  isCompleted(): boolean {
    return this.currentState === 'COMPLETED';
  }

  /**
   * Verifica se falhou
   */
  hasFailed(): boolean {
    return this.currentState === 'FAILED' || this.currentState === 'FAILED_GRACEFULLY';
  }

  /**
   * Retorna tempo no estado atual
   */
  getTimeInState(): number {
    return Date.now() - this.stateEnteredAt;
  }

  /**
   * Retorna snapshot do estado
   */
  getSnapshot(): StateMachineSnapshot {
    return {
      currentState: this.currentState,
      previousState: this.previousState,
      stateEnteredAt: this.stateEnteredAt,
      timeInState: this.getTimeInState(),
      transitionCount: this.history.length,
      history: [...this.history],
      isTerminal: this.isTerminal(),
      canResume: this.canResume()
    };
  }

  /**
   * Retorna histórico de transições
   */
  getHistory(): StateTransition[] {
    return [...this.history];
  }

  /**
   * Retorna transições permitidas do estado atual
   */
  getAllowedTransitions(): CampaignState[] {
    return STATE_TRANSITIONS[this.currentState] || [];
  }

  /**
   * Limpa recursos
   */
  dispose(): void {
    if (this.autoTransitionTimer) {
      clearTimeout(this.autoTransitionTimer);
      this.autoTransitionTimer = null;
    }
  }
}

export { STATE_TRANSITIONS, TERMINAL_STATES, RESUMABLE_STATES };
