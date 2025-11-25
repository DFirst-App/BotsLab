/**
 * Popup Notification System for Trading Bots
 * Handles take profit and stop loss notifications
 */

(function() {
  'use strict';

  // Create popup container if it doesn't exist
  let popupContainer = null;

  function initPopupContainer() {
    if (popupContainer && popupContainer.parentNode) return;

    // Wait for DOM to be ready
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPopupContainer);
        return;
      }
      // If body still doesn't exist, wait a bit
      setTimeout(initPopupContainer, 100);
      return;
    }

    // Remove existing container if it exists but isn't attached
    if (popupContainer && !popupContainer.parentNode) {
      popupContainer = null;
    }

    if (!popupContainer) {
      popupContainer = document.createElement('div');
      popupContainer.id = 'popupNotificationsContainer';
      popupContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        box-sizing: border-box;
      `;
    }

    if (!popupContainer.parentNode) {
      document.body.appendChild(popupContainer);
    }
  }

  function createPopup(type, title, message, details = {}) {
    initPopupContainer();

    const popup = document.createElement('div');
    popup.className = `popup-notification popup-${type}`;
    
    const isSuccess = type === 'success' || type === 'take-profit';
    const icon = isSuccess ? '✓' : '⚠';
    const bgGradient = isSuccess 
      ? 'linear-gradient(135deg, rgba(36, 217, 112, 0.15) 0%, rgba(36, 217, 112, 0.08) 100%)'
      : 'linear-gradient(135deg, rgba(255, 95, 109, 0.15) 0%, rgba(255, 95, 109, 0.08) 100%)';
    const borderColor = isSuccess 
      ? 'rgba(36, 217, 112, 0.4)'
      : 'rgba(255, 95, 109, 0.4)';
    const iconColor = isSuccess ? '#24d970' : '#ff5f6d';

    popup.style.cssText = `
      background: ${bgGradient};
      border: 2px solid ${borderColor};
      border-radius: 20px;
      padding: 32px 40px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1);
      pointer-events: auto;
      position: relative;
      animation: popupSlideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      backdrop-filter: blur(10px);
    `;

    const iconCircle = document.createElement('div');
    iconCircle.style.cssText = `
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: ${isSuccess ? 'rgba(36, 217, 112, 0.2)' : 'rgba(255, 95, 109, 0.2)'};
      border: 2px solid ${borderColor};
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
      font-size: 32px;
      color: ${iconColor};
      font-weight: 700;
    `;
    iconCircle.textContent = icon;

    const titleEl = document.createElement('h3');
    titleEl.textContent = title;
    titleEl.style.cssText = `
      margin: 0 0 12px;
      font-size: 24px;
      font-weight: 700;
      color: #f5f7ff;
      text-align: center;
      letter-spacing: -0.02em;
      font-family: 'Inter', system-ui, sans-serif;
    `;

    const messageEl = document.createElement('p');
    messageEl.textContent = message;
    messageEl.style.cssText = `
      margin: 0 0 20px;
      font-size: 15px;
      color: rgba(152, 162, 189, 0.9);
      text-align: center;
      line-height: 1.6;
      font-family: 'Inter', system-ui, sans-serif;
    `;

    // Add details if provided
    let detailsEl = null;
    if (details.profit !== undefined || details.trades !== undefined || details.time !== undefined) {
      detailsEl = document.createElement('div');
      detailsEl.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 20px;
        padding: 16px;
        background: rgba(15, 17, 23, 0.4);
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.08);
      `;

      if (details.profit !== undefined) {
        const profitRow = document.createElement('div');
        profitRow.style.cssText = `
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 14px;
        `;
        profitRow.innerHTML = `
          <span style="color: rgba(152, 162, 189, 0.8);">Total Profit:</span>
          <span style="color: ${details.profit >= 0 ? '#24d970' : '#ff5f6d'}; font-weight: 700;">
            ${details.profit >= 0 ? '+' : ''}$${Number(details.profit).toFixed(2)}
          </span>
        `;
        detailsEl.appendChild(profitRow);
      }

      if (details.trades !== undefined) {
        const tradesRow = document.createElement('div');
        tradesRow.style.cssText = `
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 14px;
        `;
        tradesRow.innerHTML = `
          <span style="color: rgba(152, 162, 189, 0.8);">Total Trades:</span>
          <span style="color: #ff7a18; font-weight: 700;">${details.trades}</span>
        `;
        detailsEl.appendChild(tradesRow);
      }

      if (details.time !== undefined) {
        const timeRow = document.createElement('div');
        timeRow.style.cssText = `
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 14px;
        `;
        timeRow.innerHTML = `
          <span style="color: rgba(152, 162, 189, 0.8);">Running Time:</span>
          <span style="color: #00d2ff; font-weight: 700;">${details.time}</span>
        `;
        detailsEl.appendChild(timeRow);
      }
    }

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = `
      width: 100%;
      padding: 14px 24px;
      border-radius: 12px;
      border: 1px solid ${borderColor};
      background: ${isSuccess ? 'rgba(36, 217, 112, 0.15)' : 'rgba(255, 95, 109, 0.15)'};
      color: ${iconColor};
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: 'Inter', system-ui, sans-serif;
    `;
    closeBtn.onmouseover = () => {
      closeBtn.style.background = isSuccess ? 'rgba(36, 217, 112, 0.25)' : 'rgba(255, 95, 109, 0.25)';
      closeBtn.style.transform = 'translateY(-2px)';
    };
    closeBtn.onmouseout = () => {
      closeBtn.style.background = isSuccess ? 'rgba(36, 217, 112, 0.15)' : 'rgba(255, 95, 109, 0.15)';
      closeBtn.style.transform = 'translateY(0)';
    };
    closeBtn.onclick = () => closePopup(popup);

    popup.appendChild(iconCircle);
    popup.appendChild(titleEl);
    popup.appendChild(messageEl);
    if (detailsEl) popup.appendChild(detailsEl);
    popup.appendChild(closeBtn);

    // Add CSS animation if not already added
    if (!document.getElementById('popupAnimations')) {
      const style = document.createElement('style');
      style.id = 'popupAnimations';
      style.textContent = `
        @keyframes popupSlideIn {
          from {
            opacity: 0;
            transform: scale(0.9) translateY(-20px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }

        @keyframes popupSlideOut {
          from {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          to {
            opacity: 0;
            transform: scale(0.9) translateY(-20px);
          }
        }

        .popup-notification.popup-sliding-out {
          animation: popupSlideOut 0.3s cubic-bezier(0.4, 0, 1, 1) forwards;
        }

        @media (max-width: 768px) {
          #popupNotificationsContainer {
            padding: 16px;
          }

          .popup-notification {
            padding: 24px 28px !important;
            max-width: 100% !important;
          }

          .popup-notification h3 {
            font-size: 20px !important;
          }

          .popup-notification p {
            font-size: 14px !important;
          }

          .popup-notification > div:first-child {
            width: 56px !important;
            height: 56px !important;
            font-size: 28px !important;
          }
        }

        @media (max-width: 480px) {
          #popupNotificationsContainer {
            padding: 12px;
          }

          .popup-notification {
            padding: 20px 24px !important;
          }

          .popup-notification h3 {
            font-size: 18px !important;
          }

          .popup-notification p {
            font-size: 13px !important;
          }

          .popup-notification > div:first-child {
            width: 48px !important;
            height: 48px !important;
            font-size: 24px !important;
            margin-bottom: 16px !important;
          }
        }
      `;
      document.head.appendChild(style);
    }

    return popup;
  }

  function closePopup(popup) {
    popup.classList.add('popup-sliding-out');
    setTimeout(() => {
      if (popup.parentNode) {
        popup.parentNode.removeChild(popup);
      }
    }, 300);
  }

  // Auto-close after 8 seconds if not manually closed
  function showPopup(type, title, message, details = {}, autoClose = true) {
    // Ensure DOM is ready
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          showPopup(type, title, message, details, autoClose);
        });
        return null;
      }
      // If still no body, wait a bit
      setTimeout(() => showPopup(type, title, message, details, autoClose), 100);
      return null;
    }

    // Ensure container is initialized
    initPopupContainer();
    
    // Final check - container should exist now
    if (!popupContainer || !popupContainer.parentNode) {
      console.error('Popup container not available. Retrying...');
      // Try one more time after a short delay
      setTimeout(() => {
        initPopupContainer();
        if (popupContainer && popupContainer.parentNode) {
          showPopup(type, title, message, details, autoClose);
        } else {
          console.error('Popup container still not available after retry');
        }
      }, 100);
      return null;
    }

    const popup = createPopup(type, title, message, details);
    
    if (!popup) {
      console.error('Failed to create popup');
      return null;
    }

    try {
      popupContainer.appendChild(popup);
    } catch (error) {
      console.error('Error appending popup to container:', error);
      return null;
    }

    if (autoClose) {
      setTimeout(() => {
        if (popup.parentNode) {
          closePopup(popup);
        }
      }, 8000);
    }

    return popup;
  }

  // Public API
  window.PopupNotifications = {
    showTakeProfit: function(details = {}) {
      try {
        return showPopup('take-profit', '🎉 Take Profit Reached!', 
          'Congratulations! Your bot has successfully reached the take profit target.', 
          details);
      } catch (error) {
        console.error('Error showing take profit popup:', error);
        return null;
      }
    },

    showStopLoss: function(details = {}) {
      try {
        return showPopup('stop-loss', '⚠️ Stop Loss Hit', 
          'The bot has been stopped as the stop loss limit has been reached.', 
          details);
      } catch (error) {
        console.error('Error showing stop loss popup:', error);
        return null;
      }
    },

    showSuccess: function(title, message, details = {}) {
      try {
        return showPopup('success', title, message, details);
      } catch (error) {
        console.error('Error showing success popup:', error);
        return null;
      }
    },

    showError: function(title, message, details = {}) {
      try {
        return showPopup('error', title, message, details);
      } catch (error) {
        console.error('Error showing error popup:', error);
        return null;
      }
    },

    close: function(popup) {
      try {
        closePopup(popup);
      } catch (error) {
        console.error('Error closing popup:', error);
      }
    }
  };

  // Initialize container on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPopupContainer);
  } else {
    initPopupContainer();
  }
})();

