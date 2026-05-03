interface EmptyStateProps {
  emoji?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ emoji = "📭", title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
      <div className="text-5xl mb-4">{emoji}</div>
      <p className="font-bold text-gray-900 text-base mb-1">{title}</p>
      {description ? <p className="text-sm text-gray-500 mb-5 max-w-xs">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
