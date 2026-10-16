// PRISM PATCH: the engine toasts through `react-hot-toast`; Prism routes engine messages through its own
// adapter instead, so the engine gets a no-UI sink that records the last message.
let last: string | null = null;
const toast = {
  error(message: string) {
    last = message;
  },
  success(message: string) {
    last = message;
  },
};
export const lastToastMessage = () => last;
export default toast;
