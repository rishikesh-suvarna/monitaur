const LoadingSpinner = ({ size = 'md', className = '' }) => {
  const sizeClasses = {
    sm: 'w-8 h-8',
    md: 'w-12 h-12',
    lg: 'w-16 h-16',
    xl: 'w-20 h-20',
  };

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className={`${sizeClasses[size]} relative`}>
        {/* Server Rack SVG with animations */}
        <svg
          viewBox="0 0 48 48"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="w-full h-full"
        >
          {/* Server rack frame */}
          <rect
            x="8"
            y="4"
            width="32"
            height="40"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            className="text-primary-300"
          />

          {/* Server units with staggered animations */}
          <g className="text-black">
            {/* Server 1 */}
            <rect
              x="10"
              y="6"
              width="28"
              height="6"
              fill="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '0ms', animationDuration: '1.5s' }}
            />
            <circle
              cx="34"
              cy="9"
              r="1"
              fill="white"
              className="animate-ping"
              style={{ animationDelay: '0ms', animationDuration: '1.5s' }}
            />

            {/* Server 2 */}
            <rect
              x="10"
              y="14"
              width="28"
              height="6"
              fill="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '300ms', animationDuration: '1.5s' }}
            />
            <circle
              cx="34"
              cy="17"
              r="1"
              fill="white"
              className="animate-ping"
              style={{ animationDelay: '300ms', animationDuration: '1.5s' }}
            />

            {/* Server 3 */}
            <rect
              x="10"
              y="22"
              width="28"
              height="6"
              fill="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '600ms', animationDuration: '1.5s' }}
            />
            <circle
              cx="34"
              cy="25"
              r="1"
              fill="white"
              className="animate-ping"
              style={{ animationDelay: '600ms', animationDuration: '1.5s' }}
            />

            {/* Server 4 */}
            <rect
              x="10"
              y="30"
              width="28"
              height="6"
              fill="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '900ms', animationDuration: '1.5s' }}
            />
            <circle
              cx="34"
              cy="33"
              r="1"
              fill="white"
              className="animate-ping"
              style={{ animationDelay: '900ms', animationDuration: '1.5s' }}
            />

            {/* Server 5 */}
            <rect
              x="10"
              y="38"
              width="28"
              height="4"
              fill="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '1200ms', animationDuration: '1.5s' }}
            />
            <circle
              cx="34"
              cy="40"
              r="1"
              fill="white"
              className="animate-ping"
              style={{ animationDelay: '1200ms', animationDuration: '1.5s' }}
            />
          </g>

          {/* Data flow lines */}
          <g className="text-primary-500" strokeWidth="0.5">
            <line
              x1="12"
              y1="9"
              x2="32"
              y2="9"
              stroke="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '0ms', animationDuration: '2s' }}
            />
            <line
              x1="12"
              y1="17"
              x2="32"
              y2="17"
              stroke="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '400ms', animationDuration: '2s' }}
            />
            <line
              x1="12"
              y1="25"
              x2="32"
              y2="25"
              stroke="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '800ms', animationDuration: '2s' }}
            />
            <line
              x1="12"
              y1="33"
              x2="32"
              y2="33"
              stroke="currentColor"
              className="animate-pulse"
              style={{ animationDelay: '1200ms', animationDuration: '2s' }}
            />
          </g>
        </svg>

        {/* Optional loading text for larger sizes */}
        {(size === 'lg' || size === 'xl') && (
          <div className="absolute -bottom-6 left-1/2 transform -translate-x-1/2">
            <div className="flex space-x-1">
              <div
                className="w-1 h-1 bg-primary-600 rounded-full animate-bounce"
                style={{ animationDelay: '0ms' }}
              ></div>
              <div
                className="w-1 h-1 bg-primary-600 rounded-full animate-bounce"
                style={{ animationDelay: '150ms' }}
              ></div>
              <div
                className="w-1 h-1 bg-primary-600 rounded-full animate-bounce"
                style={{ animationDelay: '300ms' }}
              ></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LoadingSpinner;
