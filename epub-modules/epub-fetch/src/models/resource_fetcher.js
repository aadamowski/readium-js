define(['require', 'module', 'jquery', 'URIjs', './markup_parser', './discover_content_type', './plain_fetcher',
    './zip_fetcher', './processed_items_registry', './resource_cache'],
    function (require, module, $, URI, MarkupParser, ContentTypeDiscovery, PlainExplodedFetcher, ZipFetcher,
              ProcessedItemsRegistry, ResourceCache) {
        console.log('resource_resolver module id: ' + module.id);


    var ResourceFetcher = function(rootUrl, libDir) {

        var self = this;

        ResourceFetcher.contentTypePackageReadStrategyMap = {
            'application/oebps-package+xml': 'exploded',
            'application/epub+zip': 'zipped',
            'application/zip': 'zipped'
        };

        var ENCRYPTION_METHODS = {
            'http://www.idpf.org/2008/embedding': embeddedFontDeobfuscateIdpf,
            'http://ns.adobe.com/pdf/enc#RC': embeddedFontDeobfuscateAdobe
        };
        var _isExploded;
        var _dataFetcher;
        var _packageFullPath;
        var _packageDom;
        var _packageDomInitializationSubscription;
        var _encryptionDom;
        var _encryptionHash;
        var _packageJson;

        this.markupParser = new MarkupParser();

        this.initialize =  function(callback) {

            _isExploded = isExploded();

            createDataFetcher(_isExploded, callback);
        };



        // INTERNAL FUNCTIONS

        function _handleError(err) {
            if (err) {
                if (err.message) {
                    console.error(err.message);
                }
                if (err.stack) {
                    console.error(err.stack);
                }
            }
            console.error(err);
        }

        function isExploded() {

            var ext = ".epub";
            return rootUrl.indexOf(ext, rootUrl.length - ext.length) === -1;
        }

        function createDataFetcher(isExploded, callback) {
            if (isExploded) {
                console.log('using new PlainExplodedFetcher');
                _dataFetcher = new PlainExplodedFetcher(self, rootUrl);
                _dataFetcher.initialize(function () {
                    callback(_dataFetcher);
                });
            } else {
                console.log('using new ZipFetcher');
                _dataFetcher = new ZipFetcher(self, rootUrl, libDir);
                callback(_dataFetcher);
            }
        }

        function fetchResourceForElement(resolvedElem, refAttrOrigVal, refAttr, contentDocumentURI, fetchMode,
                                         resolutionDeferreds, onerror, resourceDataPreprocessing) {
            var uriRelativeToPackageDocument = (new URI(refAttrOrigVal)).absoluteTo(contentDocumentURI).toString();
            var resolutionDeferred = $.Deferred();
            resolutionDeferreds.push(resolutionDeferred);

            self.relativeToPackageFetchFileContents(uriRelativeToPackageDocument, fetchMode, function (resourceData) {

                // Generate a function to replace element's resource URL with URL of fetched data.
                // The function will either be called directly, immediately (if no preprocessing of resourceData is in effect)
                // or indirectly, later after resourceData preprocessing finishes:
                var replaceResourceURL = function (finalResourceData) {
                    // Creating an object URL requires a Blob object, so resource data fetched in text mode needs to be wrapped in a Blob:
                    if (fetchMode === 'text') {
                        var textResourceContentType = ContentTypeDiscovery.identifyContentTypeFromFileName(uriRelativeToPackageDocument);
                        var declaredType = $(resolvedElem).attr('type');
                        if (declaredType) {
                            textResourceContentType = declaredType;
                        }
                        finalResourceData = new Blob([finalResourceData], {type: textResourceContentType});
                    }
                    //noinspection JSUnresolvedVariable,JSUnresolvedFunction
                    var resourceObjectURL = window.URL.createObjectURL(finalResourceData);
                    // TODO: take care of releasing object URLs when no longer needed
                    $(resolvedElem).attr(refAttr, resourceObjectURL);
                    // Store original refAttrVal in a special attribute to provide access to the original href:
                    $(resolvedElem).data('epubZipOrigHref', refAttrOrigVal);
                    resolutionDeferred.resolve();
                };

                if (resourceDataPreprocessing) {
                    var ownerDocument;
                    if (resolvedElem.ownerDocument) {
                        ownerDocument = resolvedElem.ownerDocument;
                    }
                    if (resolvedElem[0] && resolvedElem[0].ownerDocument) {
                        ownerDocument = resolvedElem[0].ownerDocument;
                    }
                    resourceDataPreprocessing(resourceData, uriRelativeToPackageDocument, ownerDocument,
                        replaceResourceURL);
                } else {
                    replaceResourceURL(resourceData);
                }
            }, onerror);
        }

        // FIXME: function has side effects on globalCssResourcesHash, localStyleSheetCssResourcesHash
        function fetchResourceForCssUrlMatch(cssUrlMatch, cssResourceDownloadDeferreds,
                                             styleSheetUriRelativeToPackageDocument, globalCssResourcesCache,
                                             stylesheetCssResourceUrlsMap, contextDocument, isStyleSheetResource) {
            var origMatchedUrlString = cssUrlMatch[0];
            var extractedUrl = cssUrlMatch[2];
            var extractedUri = new URI(extractedUrl);
            var isCssUrlRelative = extractedUri.scheme() === '';
            if (!isCssUrlRelative) {
                // Absolute URLs don't need programmatic fetching
                return;
            }
            var resourceUriRelativeToPackageDocument = (new URI(extractedUrl)).absoluteTo(styleSheetUriRelativeToPackageDocument).toString();

            var cachedResource = globalCssResourcesCache.getResourceURL(resourceUriRelativeToPackageDocument);
            if (cachedResource) {
                stylesheetCssResourceUrlsMap[origMatchedUrlString] = cachedResource;
            } else {
                var cssUrlFetchDeferred = $.Deferred();
                cssResourceDownloadDeferreds.push(cssUrlFetchDeferred);

                if (isStyleSheetResource) {
                    var alreadyImportedStylesheetHrefsRegistry = obtainImportedCssHrefsRegistry(contextDocument);
                    if (alreadyImportedStylesheetHrefsRegistry.isProcessed(resourceUriRelativeToPackageDocument)) {
                        // This stylesheet has been @imported before
                        return;
                    }
                    console.log('Css StyleSheet [' + resourceUriRelativeToPackageDocument + '] has been fetched and preprocessed before.');

                    // This resource URL points to an @import-ed CSS stylesheet file. Need to preprocess its text after
                    // fetching but before making an object URL of it:
                    self.relativeToPackageFetchFileContents(resourceUriRelativeToPackageDocument, 'text',
                        function (styleSheetResourceData) {
                            preprocessCssStyleSheetData(styleSheetResourceData, resourceUriRelativeToPackageDocument,
                                contextDocument, function(preprocessedStyleSheetData) {
                                    var resourceDataBlob = new Blob([preprocessedStyleSheetData], {type: 'text/css'});
                                    //noinspection JSUnresolvedVariable,JSUnresolvedFunction
                                    var resourceObjectURL = window.URL.createObjectURL(resourceDataBlob);
                                    stylesheetCssResourceUrlsMap[origMatchedUrlString] = resourceObjectURL;
                                    globalCssResourcesCache.putResourceURL(resourceUriRelativeToPackageDocument, resourceObjectURL);
                                    console.log('origMatchedUrlString: [' + origMatchedUrlString + '], extractedUrl: [' + extractedUrl +
                                        '], resourceObjectURL: [' + resourceObjectURL + ']');
                                    alreadyImportedStylesheetHrefsRegistry.markProcessed(resourceUriRelativeToPackageDocument);
                                    cssUrlFetchDeferred.resolve();
                                });
                        },
                        function (error) {
                            _handleError(error);
                            cssUrlFetchDeferred.resolve();
                        }
                    );
                }  else {
                    self.relativeToPackageFetchFileContents(resourceUriRelativeToPackageDocument, 'blob',
                        function (resourceDataBlob) {
                            //noinspection JSUnresolvedVariable,JSUnresolvedFunction
                            var resourceObjectURL = window.URL.createObjectURL(resourceDataBlob);
                            stylesheetCssResourceUrlsMap[origMatchedUrlString] = resourceObjectURL;
                            globalCssResourcesCache.putResourceURL(resourceUriRelativeToPackageDocument, resourceObjectURL);
                            console.log('origMatchedUrlString: [' + origMatchedUrlString + '], extractedUrl: [' + extractedUrl +
                                '], resourceObjectURL: [' + resourceObjectURL + ']');
                            cssUrlFetchDeferred.resolve();
                        },
                        function (error) {
                            _handleError(error);
                            cssUrlFetchDeferred.resolve();
                        }
                    );

                }


            }
        }

        function preprocessCssStyleSheetData(styleSheetResourceData, styleSheetUriRelativeToPackageDocument,
                                             contextDocument, callback) {
            // TODO: regexp probably invalid for url('someUrl"ContainingQuote'):
            var cssUrlRegexp = /[Uu][Rr][Ll]\(\s*(['"]?)([^']+)\1\s*\)/g;
            var nonUrlCssImportRegexp = /@[Ii][Mm][Pp][Oo][Rr][Tt]\s*(['"])([^"']+)\1/g;
            var documentCssResourcesCache = obtainCssResourcesCache(contextDocument);
            var stylesheetCssResourceUrlsMap = {};
            var cssResourceDownloadDeferreds = [];
            console.log('========');
            console.log('preprocessing Css StyleSheet Data for stylesheet [' + styleSheetUriRelativeToPackageDocument +
                ']:');
            console.log('--------');
            console.log(styleSheetResourceData);
            console.log('========');
            // Go through the stylesheet text using all regexps and process according to those regexp matches, if any:
            [nonUrlCssImportRegexp, cssUrlRegexp].forEach(function(processingRegexp) {
                // extract all URL references in the CSS sheet,
                var cssUrlMatch = processingRegexp.exec(styleSheetResourceData);
                while (cssUrlMatch != null) {
                    console.log('CSS match using regexp ' + processingRegexp + ':');
                    console.log(cssUrlMatch);
                    // then fetch and replace them with corresponding object URLs:
                    var isStyleSheetResource = false;
                    // Special handling of @import-ed stylesheet files - recursive preprocessing:
                    if (processingRegexp == nonUrlCssImportRegexp) {
                        // This resource URL points to an @import-ed CSS stylesheet file. Need to preprocess its text
                        // after fetching but before making an object URL of it:
                        isStyleSheetResource = true;
                    }
                    fetchResourceForCssUrlMatch(cssUrlMatch, cssResourceDownloadDeferreds,
                        styleSheetUriRelativeToPackageDocument, documentCssResourcesCache, stylesheetCssResourceUrlsMap,
                        contextDocument, isStyleSheetResource);
                    cssUrlMatch = processingRegexp.exec(styleSheetResourceData);
                }

            });

            if (cssResourceDownloadDeferreds.length > 0) {
                $.when.apply($, cssResourceDownloadDeferreds).done(function () {
                    for (var origMatchedUrlString in stylesheetCssResourceUrlsMap) {
                        var resourceObjectURL = stylesheetCssResourceUrlsMap[origMatchedUrlString];
                        //noinspection JSCheckFunctionSignatures
                        styleSheetResourceData =
                            styleSheetResourceData.replace(origMatchedUrlString, "url('" + resourceObjectURL + "')",
                                'g');
                    }
                    callback(styleSheetResourceData);
                });
            } else {
                callback(styleSheetResourceData);
            }
        }

        function resolveResourceElements(elemName, refAttr, fetchMode, contentDocumentDom, contentDocumentURI,
                                         resolutionDeferreds, onerror, resourceDataPreprocessing) {

            var resolvedElems = $(elemName + '[' + refAttr + ']', contentDocumentDom);

            resolvedElems.each(function (index, resolvedElem) {
                var refAttrOrigVal = $(resolvedElem).attr(refAttr);
                var refAttrUri = new URI(refAttrOrigVal);

                if (refAttrUri.scheme() === '') {
                    // Relative URI, fetch from packed EPUB archive:

                    fetchResourceForElement(resolvedElem, refAttrOrigVal, refAttr, contentDocumentURI, fetchMode,
                        resolutionDeferreds, onerror, resourceDataPreprocessing);
                }
            });
        }

        function resolveDocumentImages(contentDocumentDom, contentDocumentURI, resolutionDeferreds, onerror) {
            resolveResourceElements('img', 'src', 'blob', contentDocumentDom, contentDocumentURI, resolutionDeferreds,
                onerror);
        }

        function resolveDocumentLinkStylesheets(contentDocumentDom, contentDocumentURI, resolutionDeferreds, onerror) {
            resolveResourceElements('link', 'href', 'text', contentDocumentDom, contentDocumentURI, resolutionDeferreds,
                onerror, preprocessCssStyleSheetData);
        }

        /**
         * Obtain the reference to the registry that holds hrefs of already imported stylesheets - needed for keeping track
         * of which stylesheets have been loaded already. The registry is attached to the content document body.
         *
         * @param {Object} contentDocumentDom The content document whose body element has/will have the hashmap attached to.
         * @return {Object} The registry with hrefs as keys and an isProcessed() method returning true for stylesheets that have been loaded.
         */
        function obtainImportedCssHrefsRegistry(contentDocumentDom) {
            // The hash of already loaded/imported stylesheet hrefs is being tracked globally on the content document level:
            var alreadyImportedStylesheetHrefsRegistry = $(contentDocumentDom.body).data('epubImportedCssHrefsReg');
            if (typeof alreadyImportedStylesheetHrefsRegistry === 'undefined') {
                // first use, initialize:
                alreadyImportedStylesheetHrefsRegistry = new ProcessedItemsRegistry();
                $(contentDocumentDom.body).data('epubImportedCssHrefsReg', alreadyImportedStylesheetHrefsRegistry);
            }
            return alreadyImportedStylesheetHrefsRegistry;
        }

        /**
         * Obtain the reference to the ResourceCache object that caches already fetched resources from CSS urls - used so that
         * the given resource referenced by URL from a CSS rule is fetched only once. The cache is attached to the content document body.
         * // TODO: use it on global EPUB book level to share caching of resources referenced multiple times within the book.
         *
         * @param {Object} contentDocumentDom The content document whose body element has/will have the cache attached to.
         * @return {Object} The cache with hrefs relative to the package document (.opf) as keys
         * and browser object URL as values for fetched resources.
         */
        function obtainCssResourcesCache(contentDocumentDom) {
            // The hash of already loaded/imported stylesheet hrefs is being tracked globally on the content document level:
            var cssResourcesCache = $(contentDocumentDom.body).data('epubCssResourcesCache');
            if (typeof cssResourcesCache === 'undefined') {
                // first use, initialize:
                cssResourcesCache = new ResourceCache;
                $(contentDocumentDom.body).data('epubCssResourcesCache', cssResourcesCache);
            }
            return cssResourcesCache;
        }

        /**
         * Get stored original href (if present) from a stylesheet that has possibly been programmatically fetched from zipped EPUB
         *
         * @param {Object} styleSheet The stylesheet DOM object that can possibly have its original href stored in the special data property
         * @return {String} Either null or the original stored href of the stylesheet as present in the document's source (before being
         * programmatically fetched from zipped EPUB, which substitutes href with a blob object URL)
         */
        function getOrigHrefFromStyleSheet(styleSheet) {
            //noinspection JSUnresolvedVariable
            return $(styleSheet.ownerNode).data('epubZipOrigHref');
        }

//        function installStylesheetLoadHandlers(contentDocumentDom, contentDocumentURI, resolutionDeferreds, onerror) {
//            // TODO: instead of installing event handlers, process immediately.
//            var styleSheetLinkElems = $("link[rel~='stylesheet']", contentDocumentDom);
//            styleSheetLinkElems.each(function(index, styleSheetLinkElem) {
//                var styleSheetHref = $(styleSheetLinkElem).attr('href');
//            });
//            styleSheetLinkElems.load(function (stylesheetLoadEvent) {
//                findRelativeUnfetchedCssImportRules(stylesheetLoadEvent, contentDocumentURI, resolutionDeferreds,
//                    onerror)
//            });
//        }

        function findRelativeUnfetchedCssImportRules(styleSheetLoadEvent, contentDocumentURI, resolutionDeferreds, onerror) {
            var contentDocumentDom = styleSheetLoadEvent.currentTarget.ownerDocument;
            var alreadyImportedStylesheetHrefsRegistry = obtainImportedCssHrefsRegistry(contentDocumentDom);
            var allRelativeCssImportRulesHash = {};
            //noinspection JSUnresolvedVariable
            var styleSheet = styleSheetLoadEvent.currentTarget.sheet;
            // Any processed stylesheet element should be loaded by the resolution mechanism so we have to
            // prevent any duplicate attempts to load it if referenced in an @import rule. We add stylesheet's URLs
            // (both current and pre-resolution) to the already fetched hash so they don't get queued for fetching again:
            alreadyImportedStylesheetHrefsRegistry.markProcessed(styleSheet.href);
            var styleSheetOwnerNodeOrigHref = getOrigHrefFromStyleSheet(styleSheet);
            // TODO: test the behaviour on stylesheets with non-relative href (residing outside the zipped EPUB)
            if (styleSheetOwnerNodeOrigHref) {
                alreadyImportedStylesheetHrefsRegistry.markProcessed(styleSheetOwnerNodeOrigHref);
            }

            var cssRules = styleSheet.cssRules;
            $.each(cssRules, function (cssRuleIdx, cssRule) {
                // Cannot compare by references, as CSSImportRule symbol in the global execution context
                // refers to a different prototype instance than the cssRule prototype
                // because of different origin (renderer's iframe.contentWindow vs global window?)
                if (cssRule.constructor.name === 'CSSImportRule') {
                    var ruleHrefUri = new URI(cssRule.href);
                    var isRuleHrefUriRelative = ruleHrefUri.scheme() === '';
                    if (isRuleHrefUriRelative) {
                        var isRuleAlreadyImported = alreadyImportedStylesheetHrefsRegistry.isProcessed(cssRule.href);
                        if (!isRuleAlreadyImported) {
                            // Queue this rule for import:
                            allRelativeCssImportRulesHash[cssRule.href] = cssRule;
                        }
                    }
                }
            });

            var allRelativeCssImportRules = [];
            var hashKeys = Object.keys(allRelativeCssImportRulesHash);
            hashKeys.forEach(function (key) {
                allRelativeCssImportRules.push(allRelativeCssImportRulesHash[key]);
            });

            fetchCssImportRules(allRelativeCssImportRules, contentDocumentURI, resolutionDeferreds, onerror);
        }

        function fetchCssImportRules(unfetchedCssImportRules, contentDocumentURI, resolutionDeferreds, onerror) {
            var alreadyImportedStylesheetHrefsRegistry;
            unfetchedCssImportRules.forEach(function (unfetchedCssImportRule) {
                var parentStyleSheet = unfetchedCssImportRule.parentStyleSheet;
                //noinspection JSUnresolvedVariable
                var contentDocumentDom = parentStyleSheet.ownerNode.ownerDocument;
                if (!alreadyImportedStylesheetHrefsRegistry) {
                    alreadyImportedStylesheetHrefsRegistry = obtainImportedCssHrefsRegistry(contentDocumentDom);
                }
                var ruleHref = unfetchedCssImportRule.href;
                var isRuleAlreadyImported = alreadyImportedStylesheetHrefsRegistry.isProcessed(ruleHref);
                if (!isRuleAlreadyImported) {
                    var baseStyleSheetHref = getOrigHrefFromStyleSheet(parentStyleSheet);
                    if (!baseStyleSheetHref) {
                        baseStyleSheetHref = parentStyleSheet.href;
                    }

                    var cssFetchHref = (new URI(ruleHref)).absoluteTo(baseStyleSheetHref).toString();
                    var appendedStyleSheetLink = $('<link />', contentDocumentDom);
                    appendedStyleSheetLink.attr({
                        type: "text/css",
                        rel: "stylesheet",
                        href: cssFetchHref
                    });
                    appendedStyleSheetLink.load(function (stylesheetLoadEvent) {
                        // TODO: test whether recursion works for nested @import rules with arbitrary indirection depth.
                        findRelativeUnfetchedCssImportRules(stylesheetLoadEvent, contentDocumentURI,
                            resolutionDeferreds, onerror);
                    });

                    fetchResourceForElement(appendedStyleSheetLink, appendedStyleSheetLink.attr('href'), 'href',
                        contentDocumentURI, 'text', resolutionDeferreds, onerror, preprocessCssStyleSheetData);

                    var contentDocumentHeadElement = $('head', contentDocumentDom);
                    contentDocumentHeadElement.append(appendedStyleSheetLink);
                }
            });
        }

        function blob2BinArray(blob, callback) {
            var fileReader = new FileReader();
            fileReader.onload = function(){
                var arrayBuffer = this.result;
                callback(new Uint8Array(arrayBuffer));
            };
            fileReader.readAsArrayBuffer(blob);
        }

        // TODO: move out to the epub module, as a new "encryption" submodule?
        function xorObfuscatedBlob(obfuscatedResourceBlob, prefixLength, xorKey, callback) {
            var obfuscatedPrefixBlob = obfuscatedResourceBlob.slice(0, prefixLength);
            blob2BinArray(obfuscatedPrefixBlob, function (bytes) {
                var masklen = xorKey.length;
                for (var i = 0; i < prefixLength; i++) {
                    bytes[i] = bytes[i] ^ (xorKey[i % masklen]);
                }
                var deobfuscatedPrefixBlob = new Blob([bytes], { type: obfuscatedResourceBlob.type });
                var remainderBlob = obfuscatedResourceBlob.slice(prefixLength);
                var deobfuscatedBlob = new Blob([deobfuscatedPrefixBlob, remainderBlob],
                    { type: obfuscatedResourceBlob.type });

                callback(deobfuscatedBlob);
            });
        }

        // TODO: move out to the epub module, as a new "encryption" submodule?
        function embeddedFontDeobfuscateIdpf(obfuscatedResourceBlob, callback) {
            var uid = _packageJson.metadata.id;
            var hashedUid = window.Crypto.SHA1(unescape(encodeURIComponent(uid.trim())), { asBytes: true });
            var prefixLength = 1040;
            // Shamelessly copied from
            // https://github.com/readium/readium-chrome-extension/blob/26d4b0cafd254cfa93bf7f6225887b83052642e0/scripts/models/path_resolver.js#L102 :
            xorObfuscatedBlob(obfuscatedResourceBlob, prefixLength, hashedUid, callback);
        }

        // TODO: move out to the epub module, as a new "encryption" submodule?
        function urnUuidToByteArray(id) {
            var uuidRegexp = /(urn:uuid:)?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/i;
            var matchResults = uuidRegexp.exec(id);
            var rawUuid =  matchResults[2]+matchResults[3]+matchResults[4]+matchResults[5]+matchResults[6];
            if (! rawUuid || rawUuid.length != 32) {
                console.error('Bad UUID format for ID :' + id);
            }
            var byteArray = [];
            for (var i = 0; i < 16; i++) {
                var byteHex =  rawUuid.substr(i*2, 2);
                var byteNumber = parseInt(byteHex, 16);
                byteArray.push(byteNumber);
            }
            return byteArray;
        }

        // TODO: move out to the epub module, as a new "encryption" submodule?
        function embeddedFontDeobfuscateAdobe(obfuscatedResourceBlob, callback) {
            var uid = _packageJson.metadata.id;
            // TODO: extract the UUID and convert to big-endian binary form (16 bytes):
            var uidWordArray = urnUuidToByteArray(uid);
            var prefixLength = 1024;
            xorObfuscatedBlob(obfuscatedResourceBlob, prefixLength, uidWordArray, callback)
        }


        // PUBLIC API

        /**
         * Determine whether the documents fetched using this fetcher require special programmatic handling.
         * (resolving of internal resource references).
         * @returns {*} true if documents fetched using this fetcher require special programmatic handling
         * (resolving of internal resource references). Typically needed for zipped EPUBs or exploded EPUBs that contain
         * encrypted resources specified in META-INF/encryption.xml.
         *
         * false if documents can be fed directly into a window or iframe by src URL without using special fetching logic.
         */
        this.shouldFetchProgrammatically = function (){
            return _isExploded;
        };

        this.getPackageUrl = function() {
            return _dataFetcher.getPackageUrl();
        };

        this.getFileContentsFromPackage = function(fileRelativePath, callback, onerror) {

            _dataFetcher.fetchFileContentsText(fileRelativePath, function (fileContents) {
                callback(fileContents);
            }, onerror);
        };



        this.getXmlFileDom = function (xmlFileRelativePath, callback, onerror) {

            self.getFileContentsFromPackage(xmlFileRelativePath, function (xmlFileContents) {
                var fileDom = self.markupParser.parseXml(xmlFileContents);
                callback(fileDom);
            }, onerror);
        };

        this.getPackageFullPath = function(callback, onerror) {
            self.getXmlFileDom('META-INF/container.xml', function (containerXmlDom) {
                var packageFullPath = self.getRootFile(containerXmlDom);
                callback(packageFullPath);
            }, onerror);
        };

        this.getRootFile = function(containerXmlDom) {
            var rootFile = $('rootfile', containerXmlDom);
            var packageFullPath = rootFile.attr('full-path');
            console.log('packageFullPath: ' + packageFullPath);
            return packageFullPath;
        };

        this.getEncryptionDom = function (callback, onerror) {
            if (_encryptionDom) {
                callback(_encryptionDom);
            } else {
                self.getXmlFileDom('META-INF/encryption.xml', function (encryptionDom) {
                    _encryptionDom = encryptionDom;
                    callback(_encryptionDom);
                }, onerror);
            }
        };

        // TODO: move out to the epub module, as a new "encryption" submodule?
        this._initializeEncryptionHash = function (encryptionInitializedCallback) {
            self.getEncryptionDom(function (encryptionDom) {
                // TODO: build the hash
                if (!_encryptionHash) {
                    _encryptionHash = {};
                }

                var isEncryptionSpecified = false;

                var encryptedData = $('EncryptedData', encryptionDom);
                encryptedData.each(function (index, encryptedData) {
                    var encryptionAlgorithm = $('EncryptionMethod', encryptedData).first().attr('Algorithm');

                    // For some reason, jQuery selector "" against XML DOM sometimes doesn't match properly
                    var cipherReference = $('CipherReference', encryptedData);
                    cipherReference.each(function (index, CipherReference) {
                        var cipherReferenceURI = $(CipherReference).attr('URI');
                        console.log('Encryption/obfuscation algorithm ' + encryptionAlgorithm + ' specified for ' +
                            cipherReferenceURI);
                        isEncryptionSpecified = true;
                        _encryptionHash[cipherReferenceURI] = encryptionAlgorithm;
                    });
                });
                console.log('_encryptionHash:');
                console.log(_encryptionHash);
                if (_isExploded && isEncryptionSpecified) {
                    _isExploded = false;
                }
                encryptionInitializedCallback();
            }, function (error) {
                console.log('Found no META-INF/encryption.xml:');
                console.log(error.message);
                console.log("Document doesn't make use of encryption.");
                encryptionInitializedCallback();
            });
        };

        // TODO: move out to the epub module, as a new "encryption" submodule?
        this.getEncryptionMethodForRelativePath = function(pathRelativeToRoot) {
            if (_encryptionHash){
                return _encryptionHash[pathRelativeToRoot];
            }   else {
                return undefined;
            }
        };

        this.getDecryptionFunctionForRelativePath = function (pathRelativeToRoot) {
            var encryptionMethod = self.getEncryptionMethodForRelativePath(pathRelativeToRoot);
            if (ENCRYPTION_METHODS[encryptionMethod]) {
                return ENCRYPTION_METHODS[encryptionMethod];
            } else {
                return undefined;
            }
        };

        this.getPackageDom = function (callback, onerror) {
            if (_packageDom) {
                callback(_packageDom);
            } else {
                // TODO: use jQuery's Deferred
                // Register all callbacks interested in initialized packageDom, launch its instantiation only once
                // and broadcast to all callbacks registered during the initialization once it's done:
                if (_packageDomInitializationSubscription) {
                    _packageDomInitializationSubscription.push(callback);
                } else {
                    _packageDomInitializationSubscription = [callback];
                    self.getPackageFullPath(function (packageFullPath) {
                        _packageFullPath = packageFullPath;
                        console.log('Have set _packageFullPath' + packageFullPath);
                        self.getXmlFileDom(packageFullPath, function (packageDom) {
                            _packageDom = packageDom;
                            _packageDomInitializationSubscription.forEach(function (subscriberCallback) {
                                subscriberCallback(packageDom);
                            });
                            _packageDomInitializationSubscription = undefined;
                        })
                    }, onerror);
                }
            }
        };

        this.relativeToPackageFetchFileContents = function(relativeToPackagePath, fetchMode, fetchCallback, onerror) {

            if (! onerror) {
                onerror = _handleError;
            }

            var pathRelativeToZipRoot = decodeURIComponent(new URI(relativeToPackagePath).absoluteTo(_packageFullPath).toString());
            var fetchFunction = _dataFetcher.fetchFileContentsText;
            if (fetchMode === 'blob') {
                fetchFunction = _dataFetcher.fetchFileContentsBlob;
            } else if (fetchMode === 'data64uri') {
                fetchFunction = _dataFetcher.fetchFileContentsData64Uri;
            }
            fetchFunction.call(_dataFetcher, pathRelativeToZipRoot, fetchCallback, onerror);
        };

        this.resolveInternalPackageResources = function(contentDocumentURI, contentDocumentType, contentDocumentText,
                                                         resolvedDocumentCallback, onerror) {

            var contentDocumentDom = self.markupParser.parseMarkup(contentDocumentText, contentDocumentType);

            var resolutionDeferreds = [];

            resolveDocumentImages(contentDocumentDom, contentDocumentURI, resolutionDeferreds, onerror);
            resolveDocumentLinkStylesheets(contentDocumentDom, contentDocumentURI, resolutionDeferreds, onerror);
            // TODO: instead if installing stylesheet load handlers, provide a postProcessing function to resolveDocumentLinkStylesheets().
            //  installStylesheetLoadHandlers(contentDocumentDom, contentDocumentURI, resolutionDeferreds, onerror);

            $.when.apply($, resolutionDeferreds).done(function () {
                resolvedDocumentCallback(contentDocumentDom);
            });

        };

//        this.getPackageDom = function (callback, onerror) {
//            return _dataFetcher.getPackageDom(callback, onerror);
//        };

        // Currently needed for deobfuscating fonts
        this.setPackageJson = function(packageJson, settingFinishedCallback) {
            _packageJson = packageJson;
            this._initializeEncryptionHash(settingFinishedCallback);
        };

    };

    return ResourceFetcher

});