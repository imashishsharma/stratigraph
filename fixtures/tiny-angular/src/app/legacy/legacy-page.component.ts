/** A local decorator that looks like Angular's and is not. */
export function Page(config: { selector: string }): ClassDecorator {
  return () => {
    void config;
  };
}

@Page({ selector: 'app-legacy' })
export class LegacyPageComponent {}
