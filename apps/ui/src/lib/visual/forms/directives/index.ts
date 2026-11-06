/**
 * Registers every bespoke directive form. Import this module once (the inspector does) and the registry
 * knows them. W5a built the forms for the directives in David's Caddyfile; W5b added one file per
 * category for the other 29 (logging, headers, responses, static, TLS).
 */
import './reverse-proxy';
import './forward-auth';
import './containers';
import './simple';
import './uri';
import './file-server';
import './logging';
import './headers';
import './responses';
import './static';
import './tls';

export { reverseProxyForm } from './reverse-proxy';
export { forwardAuthForm } from './forward-auth';
export { handleForm, routeForm, handleErrorsForm, handlePathForm } from './containers';
export { redirForm, rewriteForm, tryFilesForm, importForm } from './simple';
export { uriForm } from './uri';
export { fileServerForm } from './file-server';
export { logForm, logAppendForm, logLevelForm, logNameForm, logSkipForm } from './logging';
export {
	headerForm,
	requestHeaderForm,
	requestBodyForm,
	varsForm,
	mapForm,
	methodForm,
	encodeForm,
	pushForm
} from './headers';
export {
	respondForm,
	errorForm,
	abortForm,
	interceptForm,
	invokeForm,
	bindForm,
	metricsForm,
	tracingForm,
	timeoutsForm,
	basicAuthForm
} from './responses';
export { rootForm, fsForm, templatesForm, phpFastcgiForm } from './static';
export { tlsForm, tlsMode, acmeServerForm } from './tls';
