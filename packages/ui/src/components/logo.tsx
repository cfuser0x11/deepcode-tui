import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--deep-weak, #0c1938)" />
      <path data-slot="logo-logo-mark-d" d="M12 4H4V16H12V4ZM16 20H0V0H12V0H16V20Z" fill="var(--deep-base, #1d4ed8)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--deep-weak, #0c1938)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H60V0H80V100Z" fill="var(--deep-base, #1d4ed8)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {/* 'd' */}
        <path d="M18 30H6V18H18V30Z" fill="var(--deep-weak, #0c1938)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H18V0H24V36Z" fill="var(--deep-base, #1d4ed8)" />
        {/* 'e' */}
        <path d="M54 24V30H36V24H54Z" fill="var(--deep-weak, #0c1938)" />
        <path d="M54 24H36V30H54V36H30V6H54V24ZM36 18H48V12H36V18Z" fill="var(--deep-base, #1d4ed8)" />
        {/* 'e' */}
        <path d="M84 24V30H66V24H84Z" fill="var(--deep-weak, #0c1938)" />
        <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="var(--deep-base, #1d4ed8)" />
        {/* 'p' */}
        <path d="M108 30H96V18H108V30Z" fill="var(--deep-weak, #0c1938)" />
        <path d="M96 30H108V12H96V30ZM114 36H96V42H90V6H114V36Z" fill="var(--deep-base, #1d4ed8)" />
        {/* 'c' */}
        <path d="M144 30H126V18H144V30Z" fill="var(--icon-weak-base)" />
        <path d="M144 12H126V30H144V36H120V6H144V12Z" fill="var(--icon-strong-base)" />
        {/* 'o' */}
        <path d="M168 30H156V18H168V30Z" fill="var(--icon-weak-base)" />
        <path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="var(--icon-strong-base)" />
        {/* 'd' */}
        <path d="M198 30H186V18H198V30Z" fill="var(--icon-weak-base)" />
        <path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="var(--icon-strong-base)" />
        {/* 'e' */}
        <path d="M234 24V30H216V24H234Z" fill="var(--icon-weak-base)" />
        <path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
