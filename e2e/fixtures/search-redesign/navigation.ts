export const useRouter = () => ({ push: (href: string) => { document.body.dataset.fixtureDestination = href; } });
