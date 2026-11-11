/** 后端工厂：默认 local（零服务开发后端）；VITE_BACKEND=supabase 时使用生产目标实现。 */

import type { Backend } from './adapter'
import { LocalBackend } from './local-adapter'

export async function createBackend(): Promise<Backend> {
  const mode = (import.meta.env.VITE_BACKEND as string | undefined) ?? 'local'
  if (mode === 'supabase') {
    const { SupabaseBackend } = await import('./supabase')
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
    if (!url || !anonKey) {
      throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 未配置')
    }
    return new SupabaseBackend(url, anonKey)
  }
  return new LocalBackend()
}
