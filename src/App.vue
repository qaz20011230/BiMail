<script setup lang="ts">
/** 单一表面的屏幕切换（A5）：无路由、无弹窗、无通知中心。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { copy } from './copy'
import { wall } from './lib/store'
import { downloadText, readStoredRecoveryKey } from './lib/recovery-key'
import { exportFilename, formatExport } from './lib/export'
import WallScreen from './components/WallScreen.vue'
import RecoveryScreen from './components/RecoveryScreen.vue'
import LostKeyScreen from './components/LostKeyScreen.vue'
import SettingsView from './components/SettingsView.vue'

const settingsKeyRevealed = ref(false)
const exporting = ref(false)

/**
 * 二次确认前不展示钥匙：传空串只让组件占位（CSS `.recovery-key:empty` 隐藏），
 * 确认后才传入真实钥匙或 null（null 时显示"这台设备没有钥匙的副本"）。
 */
const settingsRecoveryKey = computed<string | null>(() => {
  if (!settingsKeyRevealed.value) return ''
  return readStoredRecoveryKey()
})

onMounted(() => {
  void wall.boot()
  document.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onGlobalKeydown)
})

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && wall.screen === 'settings') {
    event.preventDefault()
    onCloseSettings()
  }
}

function onConfirmKey(): void {
  settingsKeyRevealed.value = true
}

function onCloseSettings(): void {
  settingsKeyRevealed.value = false
  wall.closeSettings()
  // 键盘用户关闭设置面后回到原入口，而不是掉到文档顶部。
  void nextTick(() => {
    document.querySelector<HTMLElement>('[data-testid="settings-entry"]')?.focus()
  })
}

async function onExport(): Promise<void> {
  if (!wall.snapshot || exporting.value) return
  exporting.value = true
  try {
    const entries = await wall.fetchAllEntries()
    downloadText(exportFilename(), formatExport(entries, wall.snapshot.my_slot))
    wall.notice(copy.exportDone)
  } catch {
    wall.notice(copy.offline)
  } finally {
    exporting.value = false
  }
}

async function onDestroy(): Promise<void> {
  settingsKeyRevealed.value = false
  await wall.destroyMyEntries()
}
</script>

<template>
  <div class="app" :data-screen="wall.screen">
    <RecoveryScreen
      v-if="wall.screen === 'recovery' && wall.recoveryKey"
      :recovery-key="wall.recoveryKey"
      @confirmed="wall.confirmRecovery()"
    />

    <WallScreen v-else-if="wall.screen === 'wall'" />

    <SettingsView
      v-else-if="wall.screen === 'settings'"
      :recovery-key="settingsRecoveryKey"
      :notices="wall.notices"
      @close="onCloseSettings"
      @confirm-key="onConfirmKey"
      @export="onExport"
      @revoke-others="wall.revokeOthers()"
      @destroy="onDestroy"
    />

    <LostKeyScreen
      v-else-if="wall.screen === 'lost'"
      :busy="wall.busy"
      :error-line="wall.errorLine"
      :allow-create="wall.canCreateWall"
      @submit="wall.submitRecoveryKey"
      @create="wall.createNewWall()"
    />

    <div v-else-if="wall.screen === 'error'" class="surface surface--notice">
      <p class="notice-line" data-testid="error-line">{{ wall.errorLine }}</p>
      <button type="button" class="word" data-testid="retry" @click="wall.retryBoot()">
        {{ copy.words.retry }}
      </button>
    </div>

    <div v-else-if="wall.screen === 'invite-error'" class="surface surface--notice">
      <p class="notice-line" data-testid="error-line">{{ wall.errorLine }}</p>
      <button
        v-if="wall.canCreateWall"
        type="button"
        class="word"
        data-testid="invite-create-wall"
        @click="wall.createNewWall()"
      >
        {{ copy.words.createWall }}
      </button>
    </div>

    <div v-else-if="wall.screen === 'fatal'" class="surface surface--notice">
      <p class="notice-line" data-testid="error-line">{{ copy.fatal }}</p>
    </div>

    <div v-else class="surface surface--boot" aria-busy="true" />
  </div>
</template>
