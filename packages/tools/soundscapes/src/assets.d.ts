/** Vite bundles .wav assets as URLs – teach TypeScript the same contract. */
declare module '*.wav' {
  const url: string;
  export default url;
}
