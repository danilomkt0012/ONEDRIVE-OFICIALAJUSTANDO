/**
 * ============================================================================
 * CONTROLADOR DE PAUSA INTELIGENTE
 * ============================================================================
 * 
 * Gerencia pausas automáticas e retomadas com ramp-up progressivo.
 * 
 * Fluxo:
 * 1. Detecta estado CRITICAL → pausa 10-30s
 * 2. Retoma com taxa reduzida (30% do original)
 * 3. Ramp-up progressivo (10% a cada 30s estável)
 * 4. Volta ao normal após estabilidade confirmada
 */

export interface SmartPauseConfig {
  minPauseDurationMs: number;
  maxPauseDurationMs: number;
  pauseIncrementPerEvent: number;
  initialResumeRatePercent: number;
  rampUpIncrementPercent: number;
  rampUpIntervalMs: number;
  stabilityWindowMs: number;
  maxRampUpPercent: number;
}

export interface PauseState {
  isPaused: boolean;
  pausedAt: number | null;
  pauseDurationMs: number;
  resumeAt: number | null;
  pauseReason: string | null;
  pauseCount: number;
  currentRatePercent: number;
  isRampingUp: boolean;
  rampUpStartedAt: number | null;
}

export interface PauseEvent {
  type: 'pause' | 'resume' | 'ramp_up';
  timestamp: number;
  reason: string;
  ratePercent: number;
  duration?: number;
}

const DEFAULT_PAUSE_CONFIG: SmartPauseConfig = {
  minPauseDurationMs: 10000,
  maxPauseDurationMs: 30000,
  pauseIncrementPerEvent: 5000,
  initialResumeRatePercent: 30,
  rampUpIncrementPercent: 10,
  rampUpIntervalMs: 30000,
  stabilityWindowMs: 60000,
  maxRampUpPercent: 100
};

export class SmartPauseController {
  private config: SmartPauseConfig;
  private state: PauseState;
  private events: PauseEvent[] = [];
  private maxEventHistory: number = 50;
  
  // Ramp-up tracking
  private rampUpTimer: ReturnType<typeof setInterval> | null = null;
  private lastStableTime: number = 0;
  private consecutiveStableIntervals: number = 0;
  
  // Pause calculation
  private recentPauseCount: number = 0;
  
  // Callbacks
  private onPauseCallback?: (reason: string, durationMs: number) => void;
  private onResumeCallback?: (ratePercent: number) => void;
  private onRampUpCallback?: (newRatePercent: number) => void;
  private onFullRecoveryCallback?: () => void;

  constructor(config?: Partial<SmartPauseConfig>) {
    this.config = { ...DEFAULT_PAUSE_CONFIG, ...config };
    
    this.state = {
      isPaused: false,
      pausedAt: null,
      pauseDurationMs: 0,
      resumeAt: null,
      pauseReason: null,
      pauseCount: 0,
      currentRatePercent: 100,
      isRampingUp: false,
      rampUpStartedAt: null
    };
  }

  /**
   * Registra callback de pausa
   */
  onPause(callback: (reason: string, durationMs: number) => void): void {
    this.onPauseCallback = callback;
  }

  /**
   * Registra callback de retomada
   */
  onResume(callback: (ratePercent: number) => void): void {
    this.onResumeCallback = callback;
  }

  /**
   * Registra callback de ramp-up
   */
  onRampUp(callback: (newRatePercent: number) => void): void {
    this.onRampUpCallback = callback;
  }

  /**
   * Registra callback de recuperação total
   */
  onFullRecovery(callback: () => void): void {
    this.onFullRecoveryCallback = callback;
  }

  /**
   * Solicita pausa por evento crítico
   */
  requestPause(reason: string): number {
    if (this.state.isPaused) {
      // Already paused - extend if needed
      return this.state.pauseDurationMs;
    }
    
    // Calculate pause duration based on recent events
    const baseDuration = this.config.minPauseDurationMs;
    const incrementalDuration = this.recentPauseCount * this.config.pauseIncrementPerEvent;
    const pauseDuration = Math.min(
      baseDuration + incrementalDuration,
      this.config.maxPauseDurationMs
    );
    
    // Update state
    this.state.isPaused = true;
    this.state.pausedAt = Date.now();
    this.state.pauseDurationMs = pauseDuration;
    this.state.resumeAt = Date.now() + pauseDuration;
    this.state.pauseReason = reason;
    this.state.pauseCount++;
    this.recentPauseCount++;
    
    // Record event
    this.recordEvent({
      type: 'pause',
      timestamp: Date.now(),
      reason,
      ratePercent: 0,
      duration: pauseDuration
    });
    
    console.log(`\n⏸️ PAUSA INTELIGENTE ATIVADA`);
    console.log(`   Motivo: ${reason}`);
    console.log(`   Duração: ${pauseDuration / 1000}s`);
    console.log(`   Pausa #${this.state.pauseCount}`);
    
    this.onPauseCallback?.(reason, pauseDuration);
    
    return pauseDuration;
  }

  /**
   * Retoma após pausa
   */
  resume(forceFullRate: boolean = false): number {
    if (!this.state.isPaused) {
      return this.state.currentRatePercent;
    }
    
    // Calculate initial resume rate
    let resumeRate: number;
    if (forceFullRate) {
      resumeRate = 100;
    } else {
      // Start low and ramp up
      resumeRate = this.config.initialResumeRatePercent;
    }
    
    // Update state
    this.state.isPaused = false;
    this.state.currentRatePercent = resumeRate;
    this.state.isRampingUp = resumeRate < 100;
    this.state.rampUpStartedAt = resumeRate < 100 ? Date.now() : null;
    
    // Record event
    this.recordEvent({
      type: 'resume',
      timestamp: Date.now(),
      reason: forceFullRate ? 'force_full' : 'auto',
      ratePercent: resumeRate
    });
    
    console.log(`\n▶️ RETOMADA INTELIGENTE`);
    console.log(`   Taxa inicial: ${resumeRate}%`);
    if (!forceFullRate) {
      console.log(`   Ramp-up: +${this.config.rampUpIncrementPercent}% a cada ${this.config.rampUpIntervalMs / 1000}s estável`);
    }
    
    this.onResumeCallback?.(resumeRate);
    
    // Start ramp-up timer if not at full rate
    if (!forceFullRate && resumeRate < 100) {
      this.startRampUp();
    }
    
    return resumeRate;
  }

  /**
   * Inicia processo de ramp-up
   */
  private startRampUp(): void {
    if (this.rampUpTimer) {
      clearInterval(this.rampUpTimer);
    }
    
    this.lastStableTime = Date.now();
    this.consecutiveStableIntervals = 0;
    
    this.rampUpTimer = setInterval(() => {
      this.checkRampUp();
    }, 5000); // Check every 5 seconds
  }

  /**
   * Verifica se pode fazer ramp-up
   */
  private checkRampUp(): void {
    if (!this.state.isRampingUp || this.state.isPaused) {
      this.stopRampUp();
      return;
    }
    
    const now = Date.now();
    const timeSinceLastStable = now - this.lastStableTime;
    
    // Check if stable for long enough
    if (timeSinceLastStable >= this.config.rampUpIntervalMs) {
      // Increment rate
      const newRate = Math.min(
        this.state.currentRatePercent + this.config.rampUpIncrementPercent,
        this.config.maxRampUpPercent
      );
      
      this.state.currentRatePercent = newRate;
      this.lastStableTime = now;
      this.consecutiveStableIntervals++;
      
      // Record event
      this.recordEvent({
        type: 'ramp_up',
        timestamp: now,
        reason: 'stability',
        ratePercent: newRate
      });
      
      console.log(`\n📈 RAMP-UP: ${this.state.currentRatePercent - this.config.rampUpIncrementPercent}% → ${newRate}%`);
      
      this.onRampUpCallback?.(newRate);
      
      // Check if fully recovered
      if (newRate >= 100) {
        this.state.isRampingUp = false;
        this.stopRampUp();
        
        console.log(`\n✅ RECUPERAÇÃO TOTAL - Taxa voltou a 100%`);
        this.onFullRecoveryCallback?.();
      }
    }
  }

  /**
   * Para ramp-up timer
   */
  private stopRampUp(): void {
    if (this.rampUpTimer) {
      clearInterval(this.rampUpTimer);
      this.rampUpTimer = null;
    }
  }

  /**
   * Reporta instabilidade (reseta ramp-up progress)
   */
  reportInstability(): void {
    if (this.state.isRampingUp) {
      this.lastStableTime = Date.now();
      this.consecutiveStableIntervals = 0;
      
      // Optionally reduce rate on instability
      if (this.state.currentRatePercent > this.config.initialResumeRatePercent) {
        const reducedRate = Math.max(
          this.config.initialResumeRatePercent,
          this.state.currentRatePercent - this.config.rampUpIncrementPercent
        );
        
        if (reducedRate < this.state.currentRatePercent) {
          console.log(`\n📉 Instabilidade detectada: ${this.state.currentRatePercent}% → ${reducedRate}%`);
          this.state.currentRatePercent = reducedRate;
          this.onRampUpCallback?.(reducedRate);
        }
      }
    }
  }

  /**
   * Reporta estabilidade
   */
  reportStability(): void {
    // Just let the ramp-up timer do its job
    // This is called externally to confirm system is stable
  }

  /**
   * Verifica se está pausado
   */
  isPaused(): boolean {
    // Check if pause has expired
    if (this.state.isPaused && this.state.resumeAt && Date.now() >= this.state.resumeAt) {
      // Auto-resume
      this.resume();
    }
    
    return this.state.isPaused;
  }

  /**
   * Verifica se está em ramp-up
   */
  isRampingUp(): boolean {
    return this.state.isRampingUp;
  }

  /**
   * Retorna taxa atual (0-100%)
   */
  getCurrentRatePercent(): number {
    if (this.state.isPaused) return 0;
    return this.state.currentRatePercent;
  }

  /**
   * Retorna multiplicador de taxa (0.0-1.0)
   */
  getRateMultiplier(): number {
    if (this.state.isPaused) return 0;
    return this.state.currentRatePercent / 100;
  }

  /**
   * Retorna tempo restante de pausa
   */
  getRemainingPauseMs(): number {
    if (!this.state.isPaused || !this.state.resumeAt) return 0;
    return Math.max(0, this.state.resumeAt - Date.now());
  }

  /**
   * Retorna estado atual
   */
  getState(): PauseState {
    return { ...this.state };
  }

  /**
   * Registra evento
   */
  private recordEvent(event: PauseEvent): void {
    this.events.push(event);
    while (this.events.length > this.maxEventHistory) {
      this.events.shift();
    }
  }

  /**
   * Retorna histórico de eventos
   */
  getEventHistory(): PauseEvent[] {
    return [...this.events];
  }

  /**
   * Força taxa específica
   */
  setRatePercent(percent: number): void {
    this.state.currentRatePercent = Math.max(0, Math.min(100, percent));
    this.state.isRampingUp = percent < 100;
    
    if (percent >= 100) {
      this.stopRampUp();
    }
  }

  /**
   * Reseta para 100%
   */
  resetToFull(): void {
    this.state.isPaused = false;
    this.state.currentRatePercent = 100;
    this.state.isRampingUp = false;
    this.stopRampUp();
    this.recentPauseCount = 0;
  }

  /**
   * Limpa recursos
   */
  dispose(): void {
    this.stopRampUp();
  }
}

export { DEFAULT_PAUSE_CONFIG };
