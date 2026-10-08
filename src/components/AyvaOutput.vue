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
          <!-- Gates whether the master "ALL" slider also drives this axis. -->
          <div class="checkbox">
            <ayva-checkbox
              v-model="allLimitsEnabled[axis]"
              :storage-key="allLimitsStorageKey(axis)"
            />
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
          <!-- Gates whether the master "max all" slider also drives this axis. -->
          <div class="checkbox">
            <ayva-checkbox
              v-model="allMaxEnabled[axis]"
              :storage-key="allMaxStorageKey(axis)"
            />
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
        <!-- Checked when every axis is enabled: toggles the whole column. -->
        <div class="checkbox">
          <ayva-checkbox v-model="allLimitsChecked" />
        </div>
        <ayva-slider
          :options="sliderOptions"
          storage-key="all-limits"
          @update="onAllLimitsUpdate"
        />
        <div class="axis max-axis">
          max all
        </div>
        <div class="checkbox">
          <ayva-checkbox v-model="allMaxChecked" />
        </div>
        <ayva-slider
          :options="maxSliderOptions"
          storage-key="max-all"
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
import AyvaCheckbox from './widgets/AyvaCheckbox.vue';
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

/** Every axis of the Output panel, in display order. */
const AXES = ['stroke', 'surge', 'sway', 'twist', 'roll', 'pitch'];

/** Builds the per-axis map that tells whether a master slider drives an axis. */
const everyAxisEnabled = (enabled) => AXES.reduce((map, axis) => {
  map[axis] = enabled;

  return map;
}, {});

export default {
  components: {
    AyvaSlider,
    AyvaCheckbox,
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
      axes: AXES,
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
      // Checkbox per axis: when unchecked, the matching master slider leaves
      // that axis alone. Checked by default, persisted like the sliders.
      allLimitsEnabled: everyAxisEnabled(true),
      allMaxEnabled: everyAxisEnabled(true),
      /*
       * While the sliders replay their stored value the matching "update" must
       * not be taken for a user move: the two master sliders restore their own
       * value on open, and applying it would overwrite the six per-axis ones.
       * Cleared at the end of mounted(), once every slider has restored itself.
       */
      restoring: true,
      showSettings: false,
    };
  },

  computed: {
    /*
     * Checkboxes of the master row: checked while every axis is enabled. Toggling
     * them flips the whole column at once.
     */
    allLimitsChecked: {
      get () {
        return this.axes.every((axis) => this.allLimitsEnabled[axis]);
      },
      set (checked) {
        this.axes.forEach((axis) => {
          this.allLimitsEnabled[axis] = checked;
        });
      },
    },

    allMaxChecked: {
      get () {
        return this.axes.every((axis) => this.allMaxEnabled[axis]);
      },
      set (checked) {
        this.axes.forEach((axis) => {
          this.allMaxEnabled[axis] = checked;
        });
      },
    },
  },

  mounted () {
    makeCollapsible(this.$el);

    // Push every max value once so the controller always has them. Sliders
    // restored from storage emit on their own, but untouched ones do not.
    this.axes.forEach((axis) => {
      const stored = sliderStorage.load(this.maxStorageKey(axis));
      this.onMaxUpdate(axis, stored ?? this.maxSliderOptions.start);
    });

    // Children are mounted before their parent, so every slider has replayed
    // its stored value by now: from here on an update comes from the user.
    this.restoring = false;
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

    allLimitsStorageKey (axis) {
      return `all-limits-${axis}`;
    },

    allMaxStorageKey (axis) {
      return `all-max-${axis}`;
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
      // Replayed a stored value instead of a real drag.
      if (this.restoring) {
        return;
      }

      const [min, max] = values.map((value) => Number(value));

      this.axes.forEach((axis) => {
        // Unchecked axes keep their own limits.
        if (!this.allLimitsEnabled[axis]) {
          return;
        }

        this.limitValues[axis] = [min, max];
      });
    },

    onAllMaxUpdate (values) {
      // Replayed a stored value instead of a real drag.
      if (this.restoring) {
        return;
      }

      const value = Number(Array.isArray(values) ? values[0] : values);

      this.axes.forEach((axis) => {
        // Unchecked axes keep their own max value.
        if (!this.allMaxEnabled[axis]) {
          return;
        }

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
 * Each axis row now holds six columns: the axis name, the checkbox that lets
 * the master "ALL" slider drive it, its limit slider, the matching "max"
 * label, the checkbox for the "max all" slider and the max slider.
 */
.limit {
  grid-template-columns: 76px 20px 162px 96px 20px minmax(0, 1fr);
  column-gap: 10px;
}

.limit .checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
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
