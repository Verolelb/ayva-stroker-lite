import {
  Ayva, GeneratorBehavior, TempestStroke, VariableDuration
} from 'ayvajs';
import _ from 'lodash';
import CustomBehaviorStorage from './custom-behavior-storage';
import ScriptRunner from './script-runner';

import { clamp, createConstantProperty, eventMixin } from './util.js';

const STATE = {
  TRANSITION_MANUAL: 0,
  TRANSITION_FREE_PLAY: 1,
  STROKING: 2,
};

const scriptGlobals = {};

class Controller extends GeneratorBehavior {
  #customBehaviorStorage = new CustomBehaviorStorage();

  #currentBehavior = null;

  #manualBehavior = null;

  #freePlay = false;

  #duration = null;

  #bpm;

  #lastStrokeConfig = null;
  
  // VARIABLES DE PAUSE "TIME MANIPULATION"
  #nextPauseTime = null;
  #pauseState = 'NONE'; // 'NONE', 'DECELERATING', 'PAUSED', 'ACCELERATING'
  #pauseStartTime = 0;
  #pauseDurationMs = 0;
  #prePauseBpm = 60;
  #currentStrokeNameStr = '';

  constructor () {
    super();

    createConstantProperty(this, 'bpmSliderState', {
      active: false,
      updated: false,
      value: null,
    });

    Object.keys(scriptGlobals).forEach((key) => {
      delete scriptGlobals[key];
    });
  }

  * generate (ayva) {
    switch (this.#computeState(ayva)) {
      case STATE.TRANSITION_MANUAL:
        yield* this.#createTransition(ayva, this.#manualBehavior);
        this.#resetManualMode();
        break;

      case STATE.TRANSITION_FREE_PLAY:
        yield* this.#createTransition(ayva, _.sample(this.strokes));
        break;

      case STATE.STROKING:
        if (this.#currentBehavior instanceof TempestStroke) {
          yield* this.#currentBehavior;
        } else {
          yield this.#currentBehavior.next();
        }
        break;

      default:
        yield 0.1;
    }
  }

  startManualMode (stroke) {
    this.#manualBehavior = stroke;
  }

  startFreePlayMode () {
    this.#freePlay = true;
    this.#lastStrokeConfig = null;
    
    // Initialisation du cycle de pauses
    this.#pauseState = 'NONE';
    this.#scheduleNextPause(); 

    if (this.#isScript()) {
      this.#currentBehavior.complete = true;
    }
  }

  resetTimer () {
    if (this.#freePlay) {
      const [min, max] = this.parameters['pattern-duration'];

      if (min === max) {
        this.#duration = new VariableDuration(min);
      } else {
        this.#duration = new VariableDuration(min, max);
      }
    }
  }

  #computeState (ayva) {
    if (this.#manualBehavior) {
      return STATE.TRANSITION_MANUAL;
    }

    if (this.#freePlay && this.#readyForNextStroke()) {
      return STATE.TRANSITION_FREE_PLAY;
    } else if (!this.#freePlay && this.#isScriptAndComplete()) {
      ayva.stop();
      return null;
    }

    if (this.#currentBehavior) {
      return STATE.STROKING;
    }

    return null;
  }

  #resetManualMode () {
    this.#manualBehavior = null;
    this.#duration = null;
    this.#freePlay = false;
    
    // Reset pause
    this.#nextPauseTime = null;
    this.#pauseState = 'NONE';
  }

  // --------------------------------------------------------------------------
  // HORLOGE DES PAUSES 
  // --------------------------------------------------------------------------
  #scheduleNextPause() {
    const intervalParam = this.parameters['pause-interval'];
    if (!intervalParam) {
        this.#nextPauseTime = null;
        return;
    }
    
    const minI = parseFloat(Array.isArray(intervalParam) ? intervalParam[0] : intervalParam);
    const maxI = parseFloat(Array.isArray(intervalParam) && intervalParam[1] !== undefined ? intervalParam[1] : minI);
    
    if (isNaN(minI) || isNaN(maxI) || maxI === 0) {
        this.#nextPauseTime = null;
        return;
    }
    
    const intervalMs = Ayva.map(Math.random(), 0, 1, minI, maxI) * 1000;
    this.#nextPauseTime = performance.now() + intervalMs;
  }
  // --------------------------------------------------------------------------

  * #createTransition (ayva, name) {
    const customBehaviorLibrary = this.#customBehaviorStorage.load();

    if (customBehaviorLibrary[name]?.type === 'ayvascript') {
      this.#currentBehavior = this.#createScriptRunner(customBehaviorLibrary[name].data.script).bind(ayva);
      this.#currentBehavior.on('error', (error) => this.$emit('script-error', name, error));
      this.$emit('update-current-behavior', name);
      this.$emit('toggle-bpm-enabled', false);
      this.resetTimer();
    } else {
      yield* this.#transitionTempestStroke(ayva, name);
    }
  }

  * #transitionTempestStroke (ayva, strokeConfigName) {
    this.#bpm = this.#generateNextBpm();
    this.$emit('update-bpm', this.#bpm);
    
    this.#currentStrokeNameStr = strokeConfigName; // Sauvegarde du nom pour l'UI

    const bpmProvider = this.#createBpmProvider();

    let nextStrokeConfig = this.#createStrokeConfig(strokeConfigName);

    if (this.#freePlay) {
      nextStrokeConfig = this.#applyAmplitudeLimit(nextStrokeConfig);
    }
    
    this.#lastStrokeConfig = _.cloneDeep(nextStrokeConfig);

    if (this.#currentBehavior instanceof TempestStroke || scriptGlobals.output instanceof TempestStroke) {
      const currentStroke = this.#currentBehavior instanceof TempestStroke ? this.#currentBehavior : scriptGlobals.output;
      
      const duration = this.#generateTransitionDuration();
      this.#currentBehavior = currentStroke
        .transition(nextStrokeConfig, bpmProvider, duration, this.#startTransition.bind(this), ($, bpm) => {
          this.#endTransition(strokeConfigName, bpm);
        });

      scriptGlobals.output = null;

      yield* this.#currentBehavior;
    } else {
      this.#currentBehavior = new TempestStroke(nextStrokeConfig, bpmProvider).bind(ayva);

      this.#startTransition(1, this.#currentBehavior.bpm);
      yield* this.#currentBehavior.start({ duration: 1, value: Ayva.RAMP_PARABOLIC });
      this.#endTransition(strokeConfigName, this.#currentBehavior.bpm);
    }
  }

  // --------------------------------------------------------------------------
  // LOGIQUE WANDERING / AMPLITUDE
  // --------------------------------------------------------------------------
  #applyAmplitudeLimit(strokeConfig) {
    let param = this.parameters['max-amplitude'];
    if (param === undefined || param === null) param = 100; 

    let rawValue = Array.isArray(param) ? param[0] : param;
    rawValue = Number(rawValue);

    if (isNaN(rawValue)) return strokeConfig;

    const maxAmp = rawValue / 100;
    if (maxAmp >= 1) return strokeConfig;

    const newConfig = _.cloneDeep(strokeConfig);

    let targetObject = null;
    if (newConfig.L0 && typeof newConfig.L0 === 'object' && newConfig.L0.from !== undefined) {
        targetObject = newConfig.L0;
    } else if (newConfig.stroke && typeof newConfig.stroke === 'object' && newConfig.stroke.from !== undefined) {
        targetObject = newConfig.stroke;
    } else {
        targetObject = newConfig;
    }
    
    if (targetObject.from === undefined || targetObject.to === undefined) {
        return strokeConfig;
    }

    const targetFrom = targetObject.from;
    const targetTo = targetObject.to;

    let lastCenter = 0.5;
    if (this.#lastStrokeConfig) {
        let lastObject = null;
        if (this.#lastStrokeConfig.L0 && this.#lastStrokeConfig.L0.from !== undefined) lastObject = this.#lastStrokeConfig.L0;
        else if (this.#lastStrokeConfig.stroke && this.#lastStrokeConfig.stroke.from !== undefined) lastObject = this.#lastStrokeConfig.stroke;
        else lastObject = this.#lastStrokeConfig;
        
        if (lastObject && lastObject.from !== undefined) {
             lastCenter = (lastObject.from + lastObject.to) / 2;
        }
    }

    let targetCenter = (targetFrom + targetTo) / 2;
    const targetHeight = Math.abs(targetTo - targetFrom);
    
    const randomDirection = (Math.random() * 2) - 1; 
    const drift = randomDirection * maxAmp;
    
    let newCenter = lastCenter + drift;

    const allowedHeight = Math.min(targetHeight, maxAmp);
    const radius = allowedHeight / 2;
    
    newCenter = clamp(newCenter, radius, 1 - radius);

    const newFrom = newCenter - radius;
    const newTo = newCenter + radius;

    targetObject.from = newFrom;
    targetObject.to = newTo;

    return newConfig;
  }

  #isScriptAndComplete () {
    return this.#isScript() && this.#currentBehavior.complete;
  }

  #isScript () {
    return this.#currentBehavior instanceof ScriptRunner;
  }

  #startTransition (duration, bpm) {
    this.$emit('transition-start', duration, bpm);
  }

  #endTransition (strokeConfig, bpm) {
    this.$emit('transition-end', strokeConfig, bpm);
    this.resetTimer();
  }

  #createStrokeConfig (stroke) {
    if (typeof stroke === 'string') {
      const customBehaviorLibrary = this.#customBehaviorStorage.load();
      const config = customBehaviorLibrary[stroke]?.data || TempestStroke.library[stroke];

      const clonedConfig = _.cloneDeep(config);
      const existingTwist = clonedConfig.twist || clonedConfig.R0;
      const noTwist = !existingTwist || (existingTwist.from === 0.5 && existingTwist.to === 0.5);

      if (this.parameters.twist && noTwist) {
        const [from, to] = this.parameters['twist-range'];
        const phase = this.parameters['twist-phase'];
        const ecc = this.parameters['twist-ecc'];

        clonedConfig.R0 = {
          from, to, phase, ecc,
        };
      }

      return clonedConfig;
    }

    return stroke;
  }

  #readyForNextStroke () {
    // On ne change pas de mouvement tant qu'on est pris dans le cycle de pause
    if (this.#pauseState !== 'NONE') return false;
    
    const ready = (!this.#duration || this.#duration.complete) && this.strokes.length && !this.bpmSliderState.active;
    return (ready && !this.#isScript()) || this.#isScriptAndComplete();
  }

  #generateTransitionDuration () {
    const [from, to] = this.parameters['transition-duration'];
    return Ayva.map(Math.random(), 0, 1, from, to);
  }

  #generateNextBpm () {
    const [from, to] = this.parameters.bpm;
    return Math.floor(Ayva.map(Math.random(), 0, 1, from, to));
  }

  #generateNextContinuousBpm (startBpm) {
    const [minBpm, maxBpm] = this.parameters.bpm;
    const [minAcc, maxAcc] = this.parameters.acceleration;
    const delta = Ayva.map(Math.random(), 0, 1, minAcc, maxAcc);
    return clamp(startBpm + (Math.random() < 0.5 ? delta : -delta), minBpm, maxBpm);
  }

  #createBpmProvider () {
    const bpmProvider = () => {
      
      // 1. CALCUL DU BPM NORMAL
      if (!this.#freePlay || this.bpmSliderState.active || this.bpmSliderState.updated) {
        this.#bpm = this.bpmSliderState.value;
        this.bpmSliderState.updated = false;
      }

      if (this.parameters['bpm-mode'] === 'continuous') {
        if (!this.bpmSliderState.active && bpmProvider.initialized) {
          const {
            startBpm, endBpm, startTime, endTime,
          } = bpmProvider;

          const time = performance.now();

          if (time >= endTime) {
            this.#bpm = endBpm;
            bpmProvider.startTime = performance.now();
            bpmProvider.endTime = bpmProvider.startTime + 1000;
            bpmProvider.startBpm = endBpm;
            bpmProvider.endBpm = this.#generateNextContinuousBpm(endBpm);
          } else {
            this.#bpm = Ayva.map(time, startTime, endTime, startBpm, endBpm);
          }

          this.$emit('update-bpm', this.#bpm);
        } else {
          bpmProvider.startTime = 0;
          bpmProvider.endTime = 0;
          bpmProvider.startBpm = this.#bpm;
          bpmProvider.endBpm = this.#bpm;
          bpmProvider.initialized = true;
        }
      }

      let targetBpm = this.#bpm;

      // ----------------------------------------------------------------------
      // 2. HIJACKING DU BPM POUR LA PAUSE (CONTRÔLE TOTAL DU TEMPS)
      // ----------------------------------------------------------------------
      if (this.#freePlay) {
          const now = performance.now();

          // A) DÉCLENCHEMENT DE LA DÉCÉLÉRATION
          if (this.#pauseState === 'NONE' && this.#nextPauseTime && now >= this.#nextPauseTime) {
              this.#pauseState = 'DECELERATING';
              this.#pauseStartTime = now;
              this.#prePauseBpm = targetBpm; // On sauvegarde la vraie vitesse du moment
              this.$emit('update-current-behavior', 'Pausing...');
          }

          // B) LA DÉCÉLÉRATION
          if (this.#pauseState === 'DECELERATING') {
              const elapsed = now - this.#pauseStartTime;
              if (elapsed < 1000) { 
                  // Pendant 1 seconde exactement, on freine
                  const progress = elapsed / 1000;
                  // Courbe exponentielle douce (Cosinus : tombe de 1 à 0)
                  const curve = Math.cos(progress * (Math.PI / 2)); 
                  
                  // On renvoie un BPM qui chute jusqu'à presque zéro
                  return Math.max(0.001, this.#prePauseBpm * curve); 
              } else {
                  // Fin du freinage, on passe en pause figée
                  this.#pauseState = 'PAUSED';
                  this.#pauseStartTime = now;
                  
                  // Tirage au sort de la durée de la pause
                  const dParam = this.parameters['pause-duration'];
                  const minD = parseFloat(Array.isArray(dParam) ? dParam[0] : dParam) || 0;
                  const maxD = parseFloat(Array.isArray(dParam) && dParam[1] !== undefined ? dParam[1] : minD) || 0;
                  
                  this.#pauseDurationMs = Ayva.map(Math.random(), 0, 1, minD, maxD) * 1000;
                  this.$emit('update-current-behavior', `Paused (${(this.#pauseDurationMs/1000).toFixed(1)}s)`);
                  
                  return 0.001; 
              }
          }

          // C) LA PAUSE FIGÉE
          if (this.#pauseState === 'PAUSED') {
              const elapsed = now - this.#pauseStartTime;
              if (elapsed < this.#pauseDurationMs) {
                  return 0.001; // Reste gelé
              } else {
                  // Fin de la pause, on prépare l'accélération
                  this.#pauseState = 'ACCELERATING';
                  this.#pauseStartTime = now;
                  
                  this.$emit('update-current-behavior', 'Resuming...');
                  
                  // On tire et on force la nouvelle vitesse cible du robot
                  const newBpm = this.#generateNextBpm();
                  this.bpmSliderState.value = newBpm;
                  this.bpmSliderState.updated = true;
                  this.$emit('update-bpm', newBpm);
                  this.#bpm = newBpm; // Met à jour targetBpm indirectement
                  
                  return 0.001; 
              }
          }

          // D) L'ACCÉLÉRATION
          if (this.#pauseState === 'ACCELERATING') {
              const elapsed = now - this.#pauseStartTime;
              if (elapsed < 1000) {
                  // Pendant 1 seconde, on accélère
                  const progress = elapsed / 1000;
                  // Courbe exponentielle douce (Sinus : monte de 0 à 1)
                  const curve = Math.sin(progress * (Math.PI / 2));
                  
                  // On renvoie un BPM qui monte vers la nouvelle cible
                  return Math.max(0.001, targetBpm * curve);
              } else {
                  // On a atteint la vitesse max, on remet tout à zéro
                  this.#pauseState = 'NONE';
                  this.#scheduleNextPause();
                  
                  // Restaure le nom du mouvement en cours
                  this.$emit('update-current-behavior', this.#currentStrokeNameStr);
                  return targetBpm;
              }
          }
      }

      return targetBpm;
    };

    return bpmProvider;
  }

  #createScriptRunner (script) {
    const parameters = Object.keys(this.parameters).reduce((result, key) => {
      Object.defineProperty(result, _.camelCase(key), {
        enumerable: true,
        get: () => this.parameters[key],
      });

      return result;
    }, {});

    if (this.#currentBehavior instanceof TempestStroke) {
      scriptGlobals.input = this.#currentBehavior;
    } else if (this.#currentBehavior instanceof ScriptRunner) {
      scriptGlobals.input = scriptGlobals.output;
    } else {
      scriptGlobals.input = null;
    }

    scriptGlobals.output = null;
    scriptGlobals.parameters = parameters;

    Object.defineProperty(scriptGlobals, 'mode', {
      configurable: true,
      enumerable: true,
      get: () => (this.#freePlay ? 'freePlay' : 'manual'),
    });

    return new ScriptRunner(script, {
      GLOBALS: scriptGlobals,
    });
  }
}

Object.assign(Controller.prototype, eventMixin);

export default Controller;