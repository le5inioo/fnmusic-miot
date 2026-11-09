/**
 * 已知的设备非播放状态。L15A 直链播放被打断后会返回 3；查询失败的 -1 不是 idle。
 * 状态可能误报：有有效进度时，消费点仍须优先检查连续推进，不能仅凭 idle 判结束。
 */
export function isDeviceIdle(status: number): boolean {
  return status === 0 || status === 2 || status === 3;
}

export function isDeviceStatusKnown(status: number): boolean {
  return status === 1 || isDeviceIdle(status);
}

/** 连续 idle 确认后，停止/空闲且媒体详情已丢失的设备需要带位置重推。 */
export function hasLostDeviceMedia(state: { status: number; hasPosition: boolean; duration: number }): boolean {
  return (state.status === 0 || state.status === 3) && state.hasPosition === false && state.duration === 0;
}
