export interface GitHubInstallation { id: number; account: string; kind: 'Organization' | 'User' }
export interface GitHubRepository { id: number; name: string; fullName: string; private: boolean; defaultBranch: string }
export interface GitHubConnection { configured: boolean; connected: boolean; login?: string }
export interface GitHubRepositorySelection { installationId: number; repositoryId: number }
export interface GitHubPage<T> { items: T[]; nextPage: number | null }
