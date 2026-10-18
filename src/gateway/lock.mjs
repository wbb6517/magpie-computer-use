// 基于 amontlabs/lcu v0.11.4，提交 bf45b8edf01bc380def2ba8355b60a4ab5e1857d。
// Copyright (c) 2026 Amont Labs. MIT license; see LICENSE in this directory.
const fs = process.getBuiltinModule('node:fs');
/** macOS 的 open(2) 标志：在打开文件时原子地取得 flock(LOCK_EX) 排他锁。 */
export const O_EXLOCK = 0x20;

/**
 * macOS：打开 `path` 并持有排他 flock；新建文件权限为 0600。
 * 其他描述符已持锁时返回 null；关闭描述符即释放锁。
 */
export function tryExclusiveOpen(path, flags = fs.constants.O_RDWR) {
  const { O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  try {
    return fs.openSync(path, flags | O_CREAT | O_NOFOLLOW | O_EXLOCK | O_NONBLOCK, 0o600);
  } catch (error) {
    if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return null;
    throw error;
  }
}

