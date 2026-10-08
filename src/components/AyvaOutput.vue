<template>
  <div class="limits-container lil-gui root">
    <div class="title" style="padding-right: 0">
      <span>Output</span>

      <ayva-connected
        :connected="device.connected"
        :mode="mode"
        @click.stop="toggleConnection"
      />

      <edit-settings-icon
        :disabled="mode !== 'Stopped' || device.connected ? '' : null" class="settings icon"
        @click.stop="mode != 'Stopped' || device.connected ? '' : (showSettings=true)"
      />
    </div>
    <div class="limits lil-gui children">
      <template v-for="axis of axes" :key="axis">
        <div
          class="limit"
          :class="axis"
        >
          <div class="axis">
            {{ axis }}
          </div>
          <ayva-slider
            :options="sliderOptions"
            :model-value="limitValues[axis]"
            :storage-key="`${axis}-limit`"
            @update="onUpdate(axis, $event)"
          />
          <div class="axis max-axis">
            {{ maxLabel(axis) }}
          </div>
          <ayva-slider
            :options="maxSliderOptions"
            :model-value="maxValues[axis]"
            :storage-key="maxStorageKey(axis)"
            @update="onMaxUpdate(axis, $event)"
          />
        </div>
      </template>

      <!-- Master sliders: one value applied to every axis at once. -->
      <div class="limit all-limits">
        <div class="axis">
          ALL
        </div>
        <ayva-slider
          :options="sliderOptions"
          @update="onAllLimitsUpdate"
        />
        <div class="axis max-axis">
          max all
        </div>
        <ayva-slider
          :options="maxSliderOptions"
          @update="onAllMaxUpdate"
        />
      </div>
    </div>

    <ayva-modal :show="showSettings" lil-gui>
      <ayva-settings ref="ayvaSettings" @close="showSettings = false" />
    </ayva-modal>
  </div>
</template>

<script>
import AyvaSlider from './widgets/AyvaSlider.vue';
import AyvaConnected from './AyvaConnected.vue';
import AyvaSettings from './AyvaSettings.vue';
import AyvaModal from './AyvaModal.vue';
import { makeCollapsible } from '../lib/util.js';
import Storage from '../lib/ayva-storage.js';

const sliderStorage = new Storage('slider-value');

/**
 * Maps every Output axis to the free play parameter that limits its motion.
 * The stroke axis keeps the historical "max-amplitude" name so existing saved
 * values (and scripts reading `parameters.maxAmplitude`) keep working.
 */
const MAX_PARAMETERS = {
  stroke: 'max-amplitude',
  surge: 'max-surge',
  sway: 'max-sway',
  twist: 'max-twist',
  roll: 'max-roll',
  pitch: 'max-pitch',
};

export default {
  components: {
    AyvaSlider,
    AyvaConnected,
    AyvaSettings,
    AyvaModal,
  },

  inject: {
    device: {
      from: 'globalDevice',
    },
  },

  props: {
    mode: {
      type: String,
      default: null,
    },
  },

  emits: ['update-limits', 'update-parameters', 'request-connection', 'disconnect'],

  data () {
    return {
      axes: ['stroke', 'surge', 'sway', 'twist', 'roll', 'pitch'],
      sliderOptions: {
        start: [0.2, 0.8],
        tooltips: true,
        margin: 0.1,
        connect: true,
        range: {
          min: [0],
          max: [1],
        },
      },
      // Mirrors the original "Max Amplitude" slider (100% = no limit).
      maxSliderOptions: {
        range: { min: 10, max: 100 },
        start: [100],
        step: 1,
      },
      // Last known value of every axis slider, bound back as :model-value so
      // the master sliders can move them all at once.
      limitValues: {},
      maxValues: {},
      showSettings: false,
    };
  },

  mounted () {
    makeCollapsible(this.$el);

    // Push every max value once so the controller always has them. Sliders
    // restored from storage emit on their own, but untouched ones do not.
    this.axes.forEach((axis) => {
      const stored = sliderStorage.load(this.maxStorageKey(axis));
      this.onMaxUpdate(axis, stored ?? this.maxSliderOptions.start);
    });
  },

  methods: {
    maxParameterName (axis) {
      return MAX_PARAMETERS[axis];
    },

    maxLabel (axis) {
      return axis === 'stroke' ? 'max amplitude' : `max ${axis}`;
    },

    maxStorageKey (axis) {
      return `free-play-${MAX_PARAMETERS[axis]}`;
    },

    onMaxUpdate (axis, values) {
      const value = Number(Array.isArray(values) ? values[0] : values);

      // Keep the value in sync so a later "max all" drag can move this handle.
      this.maxValues[axis] = value;

      this.$emit('update-parameters', {
        name: this.maxParameterName(axis),
        value: [value],
      });
    },

    onUpdate (axis, values) {
      const [min, max] = values;

      // Keep the values in sync so a later "ALL" drag can move these handles.
      this.limitValues[axis] = [min, max];

      this.updateLimit(axis, min, max);
    },

    /*
     * The master sliders only write into limitValues / maxValues. Those maps are
     * bound to the axis sliders as :model-value, so the new values move all six
     * handles at once and each of them emits its usual update event.
     */
    onAllLimitsUpdate (values) {
      const [min, max] = values.map((value) => Number(value));

      this.axes.forEach((axis) => {
        this.limitValues[axis] = [min, max];
      });
    },

    onAllMaxUpdate (values) {
      const value = Number(Array.isArray(values) ? values[0] : values);

      this.axes.forEach((axis) => {
        this.maxValues[axis] = value;
      });
    },

    updateLimit (axis, min, max) {
      const limits = {
        min: Number(min),
        max: Number(max),
      };

      this.$emit('update-limits', {
        name: axis,
        limits,
      });
    },

    toggleConnection () {
      if (!this.device.connected && this.mode === 'Stopped') {
        this.$emit('request-connection');
      } else if (this.device.connected && this.mode === 'Stopped') {
        this.$emit('disconnect');
      }
    },
  },
};
</script>

<style scoped>
.limits-container.lil-gui.root {
  width: 640px;
}

/*
 * Each axis row now holds four columns: the axis name, its limit slider, the
 * matching "max" label and its max slider.
 */
.limit {
  grid-template-columns: 76px 162px 96px minmax(0, 1fr);
  column-gap: 10px;
}

.all-limits {
  border-top: 1px solid var(--widget-color);
}

.settings.icon {
  width: 25px;
  outline: none;
  position: relative;
  top: 1px;
  padding-right: 7px;
  margin-left: 10px;
}

.settings.icon[disabled] {
  opacity: 0.25;
}

.title {
  display: flex;
  align-items: flex-start;
}
</style>
