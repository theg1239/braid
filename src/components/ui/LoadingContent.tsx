import { createContext } from 'react';

/** Gates outside the shell render its frame; nested reads keep the frame already on screen. */
export const LoadingContent = createContext(false);
