<script setup lang="ts">
/**
 * 恢复密钥屏（SPEC §3.1 / §5.6）。
 * 钥匙只在本设备展示；可复制、可下载为 .txt；必须显式点击「我已保管」才 emit confirmed。
 * 不设任何自动隐藏（无计时器），守 A5「单一表面」与文案契约。
 */

import { ref } from 'vue'
import { copy } from '../copy'
import { copyText, downloadText } from '../lib/recovery-key'

const props = defineProps<{ recoveryKey: string }>()

const emit = defineEmits<{ (e: 'confirmed'): void }>()

const copyDone = ref(false)

async function handleCopy(): Promise<void> {
  copyDone.value = await copyText(props.recoveryKey)
}

function handleDownload(): void {
  downloadText(copy.recoveryKeyFileName, props.recoveryKey)
}
</script>

<template>
  <section class="surface surface--recovery">
    <p class="recovery-line">{{ copy.recoveryScreen }}</p>
    <code class="recovery-key" data-testid="recovery-key">{{ recoveryKey }}</code>
    <div class="recovery-actions">
      <button type="button" class="word" data-testid="key-copy" @click="handleCopy">
        {{ copy.words.copy }}
      </button>
      <button type="button" class="word" data-testid="key-download" @click="handleDownload">
        {{ copy.words.downloadTxt }}
      </button>
    </div>
    <p v-if="copyDone" class="local-line">{{ copy.recoveryKeyCopyDone }}</p>
    <div class="recovery-confirm">
      <button type="button" class="word" data-testid="recovery-confirm" @click="emit('confirmed')">
        {{ copy.words.saved }}
      </button>
    </div>
  </section>
</template>
