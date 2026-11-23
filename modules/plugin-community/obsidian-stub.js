/** vitest 编译期桩：store 只用到 requestUrl（目录拉取走网络，测试不打到它）。 */
export const requestUrl = () => {
  throw new Error("requestUrl should not be called in tests");
};
export default { requestUrl };
