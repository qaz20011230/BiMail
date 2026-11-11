<script setup lang="ts">
/**
 * 唯一设置面（SPEC §3.7 / CONTRACT §5.4）。
 * 纯文本一页：四行固定顺序；查看钥匙 / 让其他设备离开 / 销毁三项点击后展开内联二次确认，
 * 无弹窗、无 Toast（A5）。动作结果以 props.notices 的逐行本地语呈现。
 */

import { ref } from 'vue'
import { copy } from '../copy'

type RowId = 'viewKey' | 'revoke' | 'destroy'

withDefaults(defineProps<{ recoveryKey: string | null; notices?: string[] }>(), {
  notices: () => [],
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm-key'): void
  (e: 'export'): void
  (e: 'revoke-others'): void
  (e: 'destroy'): void
}>()

const openRow = ref<RowId | null>(null)

function toggleRow(row: RowId): void {
  openRow.value = openRow.value === row ? null : row
}

function closeRow(): void {
  openRow.value = null
}

function confirmKey(): void {
  closeRow()
  emit('confirm-key')
}

function confirmRevoke(): void {
  closeRow()
  emit('revoke-others')
}

function confirmDestroy(): void {
  closeRow()
  emit('destroy')
}
</script>

<template>
  <section class="surface surface--settings">
    <h1 class="settings-title">{{ copy.settingsTitle }}</h1>

    <div class="settings-group">
      <button
        type="button"
        class="word settings-row"
        data-testid="settings-view-key"
        @click="toggleRow('viewKey')"
      >
        {{ copy.settingsRows.viewKey }}
      </button>
      <p v-if="recoveryKey === null" class="local-line">{{ copy.recoveryKeyMissing }}</p>
      <code v-else class="recovery-key" data-testid="settings-recovery-key">{{ recoveryKey }}</code>
      <template v-if="openRow === 'viewKey'">
        <p class="settings-confirm-line">{{ copy.keyRevealConfirm }}</p>
        <div class="settings-actions">
          <button
            type="button"
            class="word"
            data-testid="settings-view-key-confirm"
            @click="confirmKey"
          >
            {{ copy.words.confirm }}
          </button>
          <button
            type="button"
            class="word"
            data-testid="settings-view-key-cancel"
            @click="closeRow"
          >
            {{ copy.words.cancel }}
          </button>
        </div>
      </template>
    </div>

    <div class="settings-group">
      <button
        type="button"
        class="word settings-row"
        data-testid="settings-export"
        @click="emit('export')"
      >
        {{ copy.settingsRows.exportAll }}
      </button>
    </div>

    <div class="settings-group">
      <button
        type="button"
        class="word settings-row"
        data-testid="settings-revoke"
        @click="toggleRow('revoke')"
      >
        {{ copy.settingsRows.revokeOthers }}
      </button>
      <template v-if="openRow === 'revoke'">
        <p class="settings-confirm-line">{{ copy.revokeConfirm }}</p>
        <div class="settings-actions">
          <button
            type="button"
            class="word"
            data-testid="settings-revoke-confirm"
            @click="confirmRevoke"
          >
            {{ copy.words.confirm }}
          </button>
          <button type="button" class="word" data-testid="settings-revoke-cancel" @click="closeRow">
            {{ copy.words.cancel }}
          </button>
        </div>
      </template>
    </div>

    <div class="settings-group">
      <button
        type="button"
        class="word settings-row"
        data-testid="settings-destroy"
        @click="toggleRow('destroy')"
      >
        {{ copy.settingsRows.destroy }}
      </button>
      <template v-if="openRow === 'destroy'">
        <p class="settings-confirm-line">{{ copy.destroyConfirm }}</p>
        <div class="settings-actions">
          <button
            type="button"
            class="word"
            data-testid="settings-destroy-confirm"
            @click="confirmDestroy"
          >
            {{ copy.words.confirm }}
          </button>
          <button type="button" class="word" data-testid="settings-destroy-cancel" @click="closeRow">
            {{ copy.words.cancel }}
          </button>
        </div>
      </template>
    </div>

    <p v-for="(notice, index) in notices" :key="index" class="local-line">{{ notice }}</p>

    <button type="button" class="word" data-testid="settings-close" @click="emit('close')">
      {{ copy.words.back }}
    </button>
  </section>
</template>
