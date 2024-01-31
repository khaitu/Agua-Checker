'use strict';

module.exports = {
  overrides: [
    {
      files: '*.{js,ts,mts}',
      options: {
        singleQuote: true,
        printWidth: 100,
        arrowParens: 'avoid',
      },
    },
  ],
};
