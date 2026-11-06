/**
 * Registers every bespoke directive form. Import this module once (the inspector does) and the registry
 * knows them. W5b: add a file per category and import it here.
 */
import './reverse-proxy';
import './forward-auth';
import './containers';
import './simple';
import './uri';
import './file-server';

export { reverseProxyForm } from './reverse-proxy';
export { forwardAuthForm } from './forward-auth';
export { handleForm, routeForm, handleErrorsForm, handlePathForm } from './containers';
export { redirForm, rewriteForm, tryFilesForm, importForm } from './simple';
export { uriForm } from './uri';
export { fileServerForm } from './file-server';
