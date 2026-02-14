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

  // Mémoire du dernier mouvement
  #lastStrokeConfig = null;

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
        // Waiting for a command.
        yield 0.1;
    }
  }

  startManualMode (stroke) {
    this.#manualBehavior = stroke;
  }

  startFreePlayMode () {
    this.#freePlay = true;
    this.#lastStrokeConfig = null;

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
  }

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
    const bpmProvider = this.#createBpmProvider();

    let nextStrokeConfig = this.#createStrokeConfig(strokeConfigName);

    // Application de la promenade aléatoire
    if (this.#freePlay) {
      nextStrokeConfig = this.#applyAmplitudeLimit(nextStrokeConfig);
    }
    
    // Sauvegarde mémoire
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
  // LOGIQUE DE PROMENADE ALEATOIRE (RANDOM WALK)
  // --------------------------------------------------------------------------
  #applyAmplitudeLimit(strokeConfig) {
    // 1. Récupération paramètre
    let param = this.parameters['max-amplitude'];
    if (param === undefined || param === null) param = 100; 

    let rawValue = Array.isArray(param) ? param[0] : param;
    rawValue = Number(rawValue);
    if (isNaN(rawValue)) return strokeConfig;

    const maxAmp = rawValue / 100;

    // Si 100%, comportement normal
    if (maxAmp >= 1) return strokeConfig;

    const newConfig = _.cloneDeep(strokeConfig);

    // --- LECTURE CIBLE ---
    let targetObject = null;
    if (newConfig.L0 && typeof newConfig.L0 === 'object' && newConfig.L0.from !== undefined) {
        targetObject = newConfig.L0;
    } else if (newConfig.stroke && typeof newConfig.stroke === 'object' && newConfig.stroke.from !== undefined) {
        targetObject = newConfig.stroke;
    } else {
        targetObject = newConfig;
    }
    
    if (targetObject.from === undefined || targetObject.to === undefined) return strokeConfig;

    const originalFrom = targetObject.from;
    const originalTo = targetObject.to;

    // Lecture dernier centre
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

    // --- CALCUL DE LA PROMENADE ---
    
    // 1. Définir la hauteur de la vague
    // On garde la hauteur originale seulement si elle est plus petite que la limite.
    // Sinon, on la force à la limite (ex: 30%).
    const originalHeight = Math.abs(originalTo - originalFrom);
    const allowedHeight = Math.min(originalHeight, maxAmp);
    const radius = allowedHeight / 2;

    // 2. Calculer le nouveau centre (C'est ici que la magie opère)
    // Au lieu de viser 0.5, on vise : Dernier Endroit + Dérive Aléatoire
    
    // Génère un nombre entre -1 et 1
    const randomDirection = (Math.random() * 2) - 1; 
    
    // On autorise un décalage proportionnel à l'amplitude (ou un peu plus pour que ça bouge bien)
    // Ici, on autorise à bouger de 'maxAmp' vers le haut ou le bas.
    const drift = randomDirection * maxAmp;
    
    let newCenter = lastCenter + drift;

    // 3. Sécurité (Murs)
    // On s'assure que la vague ne dépasse pas 0 ou 1
    // Le centre ne peut pas être plus bas que le rayon, ni plus haut que 1-rayon.
    newCenter = clamp(newCenter, radius, 1 - radius);
    
    // 4. Application
    const newFrom = newCenter - radius;
    const newTo = newCenter + radius;

    // --- ÉCRITURE CHIRURGICALE ---
    targetObject.from = newFrom;
    targetObject.to = newTo;

    return newConfig;
  }
  // --------------------------------------------------------------------------

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

      return this.#bpm;
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