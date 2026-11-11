<script setup lang="ts">
/**
 * 凭据失效屏（SPEC §3.1 / §5.6 / CONTRACT §5.4）。
 * 一行说明 + 单行钥匙输入；单行输入非空才出现「进入」词（空态零控件精神）。
 * Enter 提交（输入法组合中不提交）；本地先 normalize + isPlausible，不合法显示一行事实语。
 * 合法时 emit 规范化后的原始钥匙（大写、去空白），父组件负责哈希、换座与本设备保管。
 */

import { computed, ref } from 'vue'
import { copy } from '../copy'
import { isPlausibleRecoveryKey, normalizeRecoveryKey } from '../lib/recovery-key'

const props = withDefaults(
  defineProps<{ busy?: boolean; errorLine?: string | null; allowCreate?: boolean }>(),
  {
    busy: false,
    errorLine: null,
    allowCreate: false,
  },
)

const emit = defineEmits<{ (e: 'submit', key: string): void; (e: 'create'): void }>()

const raw = ref('')
const invalid = ref(false)
const submitting = ref(false)

const hasInput = computed(() => raw.value.trim().length > 0)
const disabled = computed(() => props.busy || submitting.value)
/** 外部错误行优先（如换座被拒）；否则本地非法提示。都只占一行。 */
const shownError = computed(() => props.errorLine ?? (invalid.value ? copy.recoveryKeyWrong : null))

function handleInput(event: Event): void {
  raw.value = (event.target as HTMLInputElement).value
  invalid.value = false
}

function submit(): void {
  if (disabled.value) return
  const key = normalizeRecoveryKey(raw.value)
  if (!isPlausibleRecoveryKey(key)) {
    invalid.value = true
    return
  }
  invalid.value = false
  submitting.value = true
  try {
    emit('submit', key)
  } finally {
    submitting.value = false
  }
}

function handleKeydown(event: KeyboardEvent): void {
  // P0：IME 候选确认的回车绝不提交。
  if (event.isComposing || event.keyCode === 229) return
  if (event.key !== 'Enter') return
  event.preventDefault()
  submit()
}
</script>

<template>
  <section class="surface surface--lost">
    <p class="lost-line">{{ copy.lostCredential }}</p>
    <p v-if="allowCreate" class="local-line">{{ copy.noWallYet }}</p>
    <input
      class="key-input"
      data-testid="key-input"
      type="text"
      :value="raw"
      autocapitalize="characters"
      autocomplete="off"
      spellcheck="false"
      :disabled="disabled"
      @input="handleInput"
      @keydown="handleKeydown"
    />
    <div v-if="hasInput || allowCreate" class="lost-actions">
      <button
        v-if="hasInput"
        type="button"
        class="word"
        data-testid="key-submit"
        :disabled="disabled"
        @click="submit"
      >
        {{ copy.words.enter }}
      </button>
      <button
        v-if="allowCreate"
        type="button"
        class="word"
        data-testid="create-wall"
        :disabled="disabled"
        @click="emit('create')"
      >
        {{ copy.words.createWall }}
      </button>
    </div>
    <p v-if="shownError" class="local-line">{{ shownError }}</p>
  </section>
</template>
